import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

const WAIVER_YEAR = 2026;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify admin
  const { data: me } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const member_id = body?.member_id as string | undefined;
  const recipient_email = body?.recipient_email as string | undefined;
  const recipient_name = body?.recipient_name as string | undefined;

  if (!member_id || !recipient_email) {
    return NextResponse.json({ error: "member_id and recipient_email required" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("waivers")
    .upsert(
      {
        member_id,
        waiver_year: WAIVER_YEAR,
        status: "signed",
        recipient_email,
        recipient_name: recipient_name ?? null,
        external_provider: "signnow",
        signed_at: nowIso,
      },
      { onConflict: "recipient_email,waiver_year" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
