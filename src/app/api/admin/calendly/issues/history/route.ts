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

  return { ok: true as const };
}

export async function GET(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const url = new URL(req.url);
  const issue_id = url.searchParams.get("issue_id");
  if (!issue_id) return json({ error: "issue_id required" }, 400);

  const admin = createSupabaseAdminClient();

  const { data, error } = await admin
    .from("calendly_booking_issue_history")
    .select("id,created_at,resolution,notes,actor_user_id")
    .eq("issue_id", issue_id)
    .order("created_at", { ascending: true });

  if (error) return json({ error: error.message }, 400);

  return json({ ok: true, history: data ?? [] }, 200);
}
