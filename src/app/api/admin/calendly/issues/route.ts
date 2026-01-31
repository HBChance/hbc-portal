import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

async function requireAdmin() {
  const supabase = await createSupabaseServerClient();

  const { data: auth } = await supabase.auth.getUser();
  const user = auth?.user;
  if (!user) return { ok: false as const, status: 401, error: "Unauthorized" };

  const { data: me, error: meErr } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (meErr) return { ok: false as const, status: 400, error: meErr.message };
  if (!me?.is_admin) return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, user_id: user.id };
}

// Disambiguate FK for embed: calendly_booking_issues.member_id -> members.id
const MEMBER_EMBED = "member:members!calendly_booking_issues_member_id_fkey(phone)";

export async function GET(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const admin = createSupabaseAdminClient();
  const url = new URL(req.url);

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const showHandled = url.searchParams.get("show_handled") === "1";
  const range = (url.searchParams.get("range") ?? "30d") as "24h" | "30d" | "all";

  // Time window filter (default: last 30 days)
  const now = new Date();
  let startIso: string | null = null;

  if (range === "24h") {
    startIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  } else if (range === "30d") {
    startIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  } else {
    startIso = null; // all time
  }

  let q = admin
    .from("calendly_booking_issues")
    .select(
      [
        "id",
        "created_at",
        "updated_at",
        "calendly_event_uri",
        "calendly_invitee_uri",
        "invitee_email",
        "event_start_at",
        "event_end_at",
        "error_code",
        "error_message",
        "resolution",
        "handled_at",
        "notes",
        MEMBER_EMBED,
      ].join(",")
    )
    .order("created_at", { ascending: false })
    .limit(limit);

    if (!showHandled) q = q.eq("resolution", "open");
  if (startIso) q = q.gte("created_at", startIso);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 400);

  return json({ ok: true, issues: data ?? [] }, 200);
}

export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const admin = createSupabaseAdminClient();

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = body?.id as string | undefined;
  const resolution = body?.resolution as string | undefined;
  const notes = body?.notes as string | null | undefined;

  if (!id) return json({ error: "id required" }, 400);
  if (!resolution) return json({ error: "resolution required" }, 400);

  const handled_at = resolution === "open" ? null : new Date().toISOString();

  // 1) Update the "current state" row
  const { data: updated, error: updErr } = await admin
    .from("calendly_booking_issues")
    .update({
      resolution,
      handled_at,
      notes: notes ?? null,
    })
    .eq("id", id)
    .select(
      [
        "id",
        "created_at",
        "updated_at",
        "calendly_event_uri",
        "calendly_invitee_uri",
        "invitee_email",
        "event_start_at",
        "event_end_at",
        "error_code",
        "error_message",
        "resolution",
        "handled_at",
        "notes",
        MEMBER_EMBED,
      ].join(",")
    )
    .single();

  if (updErr) return json({ error: updErr.message }, 400);

  // 2) Append to history table (immutable log)
  const { error: histErr } = await admin.from("calendly_booking_issue_history").insert({
    issue_id: id,
    resolution,
    notes: notes ?? null,
    actor_user_id: gate.user_id, // optional attribution
  });

  if (histErr) {
    // Don’t fail the request if history insert fails; log and keep moving.
    console.error("[admin] failed to write issue history:", histErr.message);
  }

  return json({ ok: true, issue: updated }, 200);
}
