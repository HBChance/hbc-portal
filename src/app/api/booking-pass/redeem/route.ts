import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const CALENDLY_BASE =
  "https://calendly.com/happensbychance/flintridge-sound-bath";

export async function POST(req: Request) {
  try {
    const { token } = await req.json().catch(() => ({}));
    const t = typeof token === "string" ? token.trim() : "";

    if (!t) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    // 1) Fetch pass
    const { data: pass, error: fetchErr } = await supabaseAdmin
      .from("booking_passes")
      .select("id, email, used_at, expires_at")
      .eq("token", t)
      .maybeSingle();

    if (fetchErr || !pass) {
      return NextResponse.json({ error: "Invalid booking link" }, { status: 404 });
    }

    if (pass.used_at) {
      return NextResponse.json({ error: "This booking link has already been used." }, { status: 409 });
    }

    if (new Date(pass.expires_at).getTime() <= Date.now()) {
      return NextResponse.json({ error: "This booking link has expired." }, { status: 410 });
    }

    // 2) Mark used (idempotent: only updates if still unused)
    const { error: updErr } = await supabaseAdmin
      .from("booking_passes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", pass.id)
      .is("used_at", null);

    if (updErr) {
      return NextResponse.json({ error: "Could not redeem booking link. Please try again." }, { status: 500 });
    }

    // 3) Optional prefill Calendly (email only; name can be added later)
    const redirectUrl = `${CALENDLY_BASE}?email=${encodeURIComponent(pass.email)}`;

    return NextResponse.json({ redirect_url: redirectUrl }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
