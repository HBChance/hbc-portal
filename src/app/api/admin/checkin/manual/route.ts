import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client"; // adjust path if different

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
}
function fmtLa(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
export async function POST(req: Request) {
  // Auth as logged-in user
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user) return json(false, { error: "Unauthorized" }, 401);

  // Confirm admin
  const { data: me, error: meErr } = await supabaseAuth
    .from("members")
    .select("id,is_admin")
    .eq("user_id", user.id)
    .single();

  if (meErr) return json(false, { error: meErr.message }, 500);
  if (!me?.is_admin) return json(false, { error: "Forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const email = body?.email ? String(body.email).trim().toLowerCase() : null;
  const sessionStartIso = body?.sessionStart ? String(body.sessionStart).trim() : null;
  const lookup = body?.lookup === true;
  const selectedRsvpId = body?.selected_rsvp_id ? String(body.selected_rsvp_id).trim() : null;

  if (!email) return json(false, { error: "email is required" }, 400);
  const supabase = createSupabaseAdminClient();
    
// LOOKUP MODE:
  // Return booked sessions for this attendee that are current/past and not already checked in.
  if (lookup) {
    const nowIso = new Date().toISOString();

    const { data: rsvps, error: rsvpErr } = await supabase
      .from("rsvps")
      .select("id, member_id, invitee_email, event_start_at, status")
      .ilike("invitee_email", email)
      .eq("status", "booked")
      .lte("event_start_at", nowIso)
      .order("event_start_at", { ascending: false })
      .limit(10);

    if (rsvpErr) return json(false, { error: rsvpErr.message }, 500);

    const rsvpIds = (rsvps ?? []).map((r: any) => r.id);
    if (rsvpIds.length === 0) {
      return json(true, {
        sessions: [],
        message: "No booked current or past sessions found for this attendee.",
      });
    }

    const { data: checkins, error: ckErr } = await supabase
      .from("checkins")
      .select("rsvp_id, entry_approved")
      .in("rsvp_id", rsvpIds)
      .eq("entry_approved", true);

    if (ckErr) return json(false, { error: ckErr.message }, 500);

    const checkedSet = new Set((checkins ?? []).map((c: any) => c.rsvp_id));

    const eligible = (rsvps ?? []).filter((r: any) => !checkedSet.has(r.id));

    return json(true, {
      sessions: eligible.map((r: any) => ({
        rsvp_id: r.id,
        event_start_at: r.event_start_at,
        label: `${fmtLa(r.event_start_at)} (America/Los_Angeles)`,
      })),
      message:
        eligible.length === 0
          ? "All booked current or past sessions for this attendee already have a confirmed check-in."
          : undefined,
    });
  }
let sessionStart: Date | null = null;
  let rsvp: any = null;
  let rsvpErr: any = null;

  if (selectedRsvpId) {
    const out = await supabase
      .from("rsvps")
      .select("id, member_id, invitee_email, event_start_at, status")
      .eq("id", selectedRsvpId)
      .ilike("invitee_email", email)
      .eq("status", "booked")
      .maybeSingle();

    rsvp = out.data;
    rsvpErr = out.error;

    if (rsvp?.event_start_at) {
      sessionStart = new Date(rsvp.event_start_at);
    }
  } else {
    if (sessionStartIso) {
      sessionStart = new Date(sessionStartIso);
      if (!Number.isFinite(sessionStart.getTime())) {
        return json(false, { error: "Invalid sessionStart ISO" }, 400);
      }
    }

    // 1) Find RSVP for that attendee.
    // If sessionStart was provided, use exact match.
    // Otherwise auto-detect the currently active session window.
    if (sessionStart) {
      const out = await supabase
        .from("rsvps")
        .select("id, member_id, invitee_email, event_start_at, status")
        .eq("event_start_at", sessionStart.toISOString())
        .ilike("invitee_email", email)
        .eq("status", "booked")
        .maybeSingle();

      rsvp = out.data;
      rsvpErr = out.error;
    } else {
      const nowMs = Date.now();
      const windowStartIso = new Date(nowMs - 12 * 60 * 60 * 1000).toISOString();
      const windowEndIso = new Date(nowMs + 12 * 60 * 60 * 1000).toISOString();

      const out = await supabase
        .from("rsvps")
        .select("id, member_id, invitee_email, event_start_at, status")
        .ilike("invitee_email", email)
        .eq("status", "booked")
        .gte("event_start_at", windowStartIso)
        .lte("event_start_at", windowEndIso)
        .order("event_start_at", { ascending: true })
        .limit(10);

      rsvpErr = out.error;

      const rows = out.data ?? [];
      const CHECKIN_OPENS_MINUTES = 60;
      const CHECKIN_CLOSES_MINUTES = 150;

      const active = rows.filter((x: any) => {
        const startMs = Date.parse(x.event_start_at);
        if (!Number.isFinite(startMs)) return false;

        const opensAtMs = startMs - CHECKIN_OPENS_MINUTES * 60 * 1000;
        const closesAtMs = startMs + CHECKIN_CLOSES_MINUTES * 60 * 1000;

        return nowMs >= opensAtMs && nowMs <= closesAtMs;
      });

      if (active.length > 0) {
        rsvp = active.sort(
          (a: any, b: any) => Date.parse(a.event_start_at) - Date.parse(b.event_start_at)
        )[0];
      } else if (rows.length > 0) {
        rsvp = rows.sort((a: any, b: any) => {
          const da = Math.abs(Date.parse(a.event_start_at) - nowMs);
          const db = Math.abs(Date.parse(b.event_start_at) - nowMs);
          return da - db;
        })[0];
      }
    }

    if (!sessionStart && rsvp?.event_start_at) {
      sessionStart = new Date(rsvp.event_start_at);
    }
  }

  if (rsvpErr) return json(false, { error: rsvpErr.message }, 500);
  if (!rsvp?.id) {
    return json(false, { error: "No booked RSVP found for that attendee in the selected session" }, 404);
  }
if (!sessionStart) {
    return json(false, { error: "Could not determine session start for selected RSVP" }, 400);
  }
  // 2) Idempotency: do not double-insert for same RSVP + session_start
  const { data: existing, error: exErr } = await supabase
    .from("checkins")
    .select("id")
    .eq("rsvp_id", rsvp.id)
    .eq("session_start", sessionStart.toISOString())
    .limit(1);

  if (exErr) return json(false, { error: exErr.message }, 500);
  if (existing && existing.length > 0) {
    return json(true, { inserted: false, reason: "already_checked_in", checkin_id: existing[0].id });
  }

  // 3) Determine waiver verification for the year
  const waiverYear = sessionStart.getUTCFullYear();

  // Adjust this query to your actual waiver table schema.
  // If you tell me your table name/columns, I’ll wire it perfectly.
   let waiverVerified = false;

  // If we don't have a member_id tied to this RSVP, we cannot verify waiver by member.
  if (rsvp.member_id) {
    const { data: waiverRow, error: waiverErr } = await supabase
      .from("waivers")
      .select("id, status, signed_at, waiver_year")
      .eq("member_id", rsvp.member_id)
      .eq("waiver_year", waiverYear)
      .maybeSingle();

    if (waiverErr) return json(false, { error: waiverErr.message }, 500);

    waiverVerified = Boolean(waiverRow && String((waiverRow as any).status) === "signed");
  }

  const now = new Date().toISOString();

  // 4) Insert checkin
  const payload: any = {
    session_start: sessionStart.toISOString(),
    checkin_at: now,
    waiver_year: waiverYear,
    waiver_verified: waiverVerified,
    entry_approved: true,
    denied_reason: waiverVerified ? null : "Admin manual check-in; waiver not verified",
    scanned_by: me.id,
    created_at: now,
    rsvp_id: rsvp.id,
    member_id: rsvp.member_id ?? null,
  };

  const { data: inserted, error: insErr } = await supabase
    .from("checkins")
    .insert(payload)
    .select("id")
    .single();

  if (insErr) return json(false, { error: insErr.message }, 500);

  return json(true, { inserted: true, checkin_id: inserted.id });
}