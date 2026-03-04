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
  if (!sessionStartIso) return json(false, { error: "sessionStart is required for admin manual check-in" }, 400);

  const sessionStart = new Date(sessionStartIso);
  if (!Number.isFinite(sessionStart.getTime())) {
    return json(false, { error: "Invalid sessionStart ISO" }, 400);
  }

  const supabase = createSupabaseAdminClient();

  // 1) Find RSVP for that attendee + exact session
  const { data: rsvp, error: rsvpErr } = await supabase
    .from("rsvps")
    .select("id, member_id, invitee_email, event_start_at")
    .eq("event_start_at", sessionStart.toISOString())
    .ilike("invitee_email", email) // case-insensitive match
    .maybeSingle();

  if (rsvpErr) return json(false, { error: rsvpErr.message }, 500);
  if (!rsvp?.id) return json(false, { error: "No RSVP found for that email + sessionStart" }, 404);

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