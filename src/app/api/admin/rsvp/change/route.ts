import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
}

export async function POST(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const admin = createSupabaseAdminClient();

    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();

    if (!user) return json(false, { error: "Unauthorized" }, 401);

    const { data: me, error: meErr } = await supabaseAuth
      .from("members")
      .select("is_admin")
      .eq("user_id", user.id)
      .single();

    if (meErr) return json(false, { error: meErr.message }, 500);
    if (!me?.is_admin) return json(false, { error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const member_id = body?.member_id ? String(body.member_id).trim() : null;
    const email = body?.email ? String(body.email).trim().toLowerCase() : null;

    if (!member_id && !email) {
      return json(false, { error: "member_id or email is required" }, 400);
    }

    let q = admin
      .from("rsvps")
      .select("id, member_id, calendly_invitee_uri, event_start_at, status, invitee_email")
      .eq("status", "booked")
      .not("calendly_invitee_uri", "is", null)
      .order("event_start_at", { ascending: true });

    if (member_id) q = q.eq("member_id", member_id);
    else q = q.eq("invitee_email", email);

    const { data: rows, error: rsvpErr } = await q.limit(20);

    if (rsvpErr) return json(false, { error: rsvpErr.message }, 500);

    const nowIso = new Date().toISOString();
    const candidates = (rows ?? []).filter((r: any) => String(r.event_start_at ?? "") >= nowIso);

    if (candidates.length === 0) {
      return json(false, { error: "No future booked RSVP found to change." }, 404);
    }

    const rsvp = candidates[0];
    const inviteeUri = String(rsvp.calendly_invitee_uri ?? "").trim();
    if (!inviteeUri) {
      return json(false, { error: "RSVP is missing Calendly invitee URI." }, 400);
    }

    const calendlyPat = process.env.CALENDLY_PAT;
    if (!calendlyPat) {
      return json(false, { error: "Missing CALENDLY_PAT env var" }, 500);
    }

    const inviteeId = inviteeUri.split("/").pop();
    if (!inviteeId) {
      return json(false, { error: "Could not parse Calendly invitee id." }, 400);
    }

    const resp = await fetch(`https://api.calendly.com/invitees/${inviteeId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${calendlyPat}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json(false, { error: data?.title || data?.message || `Calendly fetch failed (${resp.status})` }, 502);
    }

    const resource = data?.resource ?? data?.collection?.[0] ?? data ?? null;
    const rescheduleUrl =
      resource?.reschedule_url ??
      resource?.rescheduleUrl ??
      null;

    if (!rescheduleUrl) {
      return json(false, { error: "Calendly did not return a reschedule URL." }, 404);
    }

    return json(true, {
      rsvp_id: rsvp.id,
      event_start_at: rsvp.event_start_at,
      calendly_invitee_uri: inviteeUri,
      reschedule_url: rescheduleUrl,
    });
  } catch (e: any) {
    return json(false, { error: e?.message || "Server error" }, 500);
  }
}