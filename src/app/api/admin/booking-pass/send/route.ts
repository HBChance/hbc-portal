import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import crypto from "crypto";

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function POST(req: Request) {
  // Auth + admin check (browser session)
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const emailRaw = (body?.email as string | undefined) ?? "";
  const memberId = (body?.member_id as string | undefined) ?? null;

  const email = emailRaw.toLowerCase().trim();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  // Mint token + store hash
  const token = crypto.randomUUID();
  const token_hash = sha256Hex(token);

  const supabaseAdmin = createSupabaseAdminClient();

  // Safety: revoke any previous unused passes for this email/member so only ONE link can exist at a time
  await supabaseAdmin
    .from("booking_passes")
    .update({ used_at: new Date().toISOString() })
    .eq("email", email)
    .is("used_at", null);
  const { error: insErr } = await supabaseAdmin
    .from("booking_passes")
    .insert({
      token_hash,
      email,
      member_id: memberId,
    });

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });

  // Email via Edge Function (reuse your existing send-booking-pass)
  const cronKey = mustGetEnv("CRON_INVOKE_KEY");
  const base = mustGetEnv("SUPABASE_FUNCTIONS_BASE_URL"); 
  // e.g. https://vffglvixaokvtdrdpvtd.functions.supabase.co

  const redeemUrl = `${base}/redeem-booking-pass?token=${encodeURIComponent(token)}`;

  const resp = await fetch(`${base}/send-booking-pass`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-key": cronKey,
    },
    body: JSON.stringify({
      to: email,
      subject: "Your booking link — Happens By Chance",
      html:
        `<p>Here is your one-time booking link:</p>` +
        `<p><a href="${redeemUrl}">Book your session</a></p>` +
        `<p>This link can only be used once.</p>`,
    }),
  });

  const outText = await resp.text();
  if (!resp.ok) {
    return NextResponse.json(
      { error: `send-booking-pass failed (${resp.status}): ${outText}` },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
