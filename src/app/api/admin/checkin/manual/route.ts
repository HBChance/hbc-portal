import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client"; // adjust path if different

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
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
  const email = body?.email ? String(body.email).trim() : null;
  const sessionStartIso = body?.sessionStart ? String(body.sessionStart).trim() : null;

  if (!email) return json(false, { error: "email is required" }, 400);
  
    let sessionStart: Date | null = null;

  if (sessionStartIso) {
    sessionStart = new Date(sessionStartIso);
    if (!Number.isFinite(sessionStart.getTime())) {
      return json(false, { error: "Invalid sessionStart ISO" }, 400);
    }
  }

  const supabase = createSupabaseAdminClient();

    // 1) Find RSVP for that attendee.
  // If sessionStart was provided, use exact match.
  // Otherwise auto-detect the currently active session window.
  let rsvp: any = null;
  let rsvpErr: any = null;

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

  if (rsvpErr) return json(false, { error: rsvpErr.message }, 500);
  if (!rsvp?.id) {
    return json(false, { error: "No booked RSVP found for that attendee in the active session window" }, 404);
  }

  // If sessionStart was omitted, derive it from the matched RSVP
  if (!sessionStart) {
    sessionStart = new Date(rsvp.event_start_at);
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