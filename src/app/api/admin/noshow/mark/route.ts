import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabaseAuth = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();

  // auth
  const { data: { user } } = await supabaseAuth.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabaseAuth
    .from("members")
    .select("id,is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const rsvp_id = body?.rsvp_id ? String(body.rsvp_id) : null;
  if (!rsvp_id) return NextResponse.json({ ok: false, error: "rsvp_id is required" }, { status: 400 });

  // load RSVP
  const { data: rsvp, error: rErr } = await admin
    .from("rsvps")
    .select("id,member_id,invitee_email,invitee_name,event_start_at,status")
    .eq("id", rsvp_id)
    .maybeSingle();

  if (rErr) return NextResponse.json({ ok: false, error: rErr.message }, { status: 400 });
  if (!rsvp) return NextResponse.json({ ok: false, error: "RSVP not found" }, { status: 404 });
  if (rsvp.status !== "booked") return NextResponse.json({ ok: false, error: "RSVP not booked" }, { status: 400 });

  const eventStartIso = rsvp.event_start_at ? new Date(rsvp.event_start_at).toISOString() : null;
  if (!eventStartIso) return NextResponse.json({ ok: false, error: "RSVP missing event_start_at" }, { status: 400 });

  // enforce "only after close" (90 min after start)
  const closesAtMs = Date.parse(eventStartIso) + 90 * 60 * 1000;
  if (Date.now() < closesAtMs) {
    return NextResponse.json(
      { ok: false, error: "TOO_EARLY", message: "No-show can only be marked after check-in closes." },
      { status: 400 }
    );
  }

  // if they checked in (for this RSVP), refuse
  const { data: ck } = await admin
    .from("checkins")
    .select("id")
    .eq("rsvp_id", rsvp_id)
    .eq("entry_approved", true)
    .limit(1)
    .maybeSingle();

  if (ck?.id) {
    return NextResponse.json(
      { ok: false, error: "ALREADY_CHECKED_IN", message: "This RSVP already checked in." },
      { status: 400 }
    );
  }

  // upsert no-show
  const { error: nsErr } = await admin
  .from("no_shows")
  .upsert(
    {
      rsvp_id: rsvp.id,
      member_id: rsvp.member_id,
      session_start: eventStartIso,
      invitee_email: rsvp.invitee_email ?? null,
      invitee_name: rsvp.invitee_name ?? null,
      marked_by: me.id,
      note: "Marked from /admin",
    },
    { onConflict: "rsvp_id" }
  );

  if (nsErr) return NextResponse.json({ ok: false, error: nsErr.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}