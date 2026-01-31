import { createSupabaseServerClient } from "@/lib/supabase/server-client";

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  // auth
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) return json({ error: "UNAUTHORIZED" }, 401);

  // admin check
  const { data: me, error: meErr } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (meErr) return json({ error: meErr.message }, 500);
  if (!me?.is_admin) return json({ error: "FORBIDDEN" }, 403);

  // body
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const member_id = String(body?.member_id ?? "");
  const reason = String(body?.reason ?? "Manual redemption (-1)");

  if (!member_id) return json({ error: "MISSING_MEMBER_ID" }, 400);

  const { data, error } = await supabase.rpc("redeem_credit", {
    p_member_id: member_id,
    p_reason: reason,
  });

  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, result: data });
}
