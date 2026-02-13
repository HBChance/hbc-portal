import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function POST(req: Request) {
  try {
    // ---- AuthZ: must be an admin user
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createSupabaseAdminClient();

    const { data: me, error: meErr } = await admin
      .from("members")
      .select("id,is_admin")
      .eq("user_id", user.id)
      .maybeSingle();

    if (meErr) throw meErr;
    if (!me?.is_admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ---- Input
    const body = await req.json().catch(() => ({}));
    const emailRaw = String(body?.email ?? "").trim();
    const stripeSessionId =
      body?.stripe_session_id != null ? String(body.stripe_session_id) : null;

    if (!emailRaw) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }

    const email = normalizeEmail(emailRaw);
    // ---- Must be an existing member with >= 1 credit
    const { data: memberRow, error: memberErr } = await admin
      .from("members")
      .select("id,email")
      .ilike("email", email)
      .maybeSingle();

    if (memberErr) {
      return NextResponse.json({ error: memberErr.message }, { status: 500 });
    }

    if (!memberRow) {
      return NextResponse.json(
        { error: "No member found for this email. Create member / add credit first." },
        { status: 400 }
      );
    }

    const { data: ledgerRows, error: ledgerErr } = await admin
      .from("credits_ledger")
      .select("entry_type,quantity")
      .eq("member_id", memberRow.id);

    if (ledgerErr) {
      return NextResponse.json({ error: ledgerErr.message }, { status: 500 });
    }

    let balance = 0;
    for (const r of ledgerRows ?? []) {
      if (r.entry_type === "grant" || r.entry_type === "refund") balance += r.quantity ?? 0;
      else if (r.entry_type === "redeem") balance -= r.quantity ?? 0;
    }

    if (balance < 1) {
      return NextResponse.json(
        { error: "Insufficient credits. Add +1 credit first, then send booking link." },
        { status: 400 }
      );
    }

    // ---- Generate booking pass token (REQUIRED by schema)
    const token = crypto.randomBytes(32).toString("base64url"); // URL-safe
    const tokenHash = sha256Hex(token);

    // 30 days
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // ---- Insert booking pass row (token is NOT NULL)
    const { error: insertErr } = await admin.from("booking_passes").insert({
  token,
  token_hash: tokenHash,
  email,
  stripe_session_id: stripeSessionId,
  expires_at: expiresAt,
  member_id: memberRow.id,
});


    if (insertErr) {
      return NextResponse.json(
        { error: insertErr.message },
        { status: 500 }
      );
    }

    // ---- Build booking URL
    // Keep using your existing redeem function (Supabase Edge function)
    const bookingUrl =
      `https://vffglvixaokvtdrdpvtd.functions.supabase.co/redeem-booking-pass?token=${token}`;

    const html = `
      <p>Here is your booking link.</p>
      <p><a href="${bookingUrl}"><strong>Click here to book your Flintridge Sound Bath</strong></a></p>
      <p>This link can be used <strong>once</strong> and expires in <strong>48 hours</strong>.</p>
    `;

    // ---- Send email via Edge Function (Resend)
    // Uses the same mechanism as your Stripe webhook.
    await fetch(
      "https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-key": mustGetEnv("CRON_INVOKE_KEY"),
        },
        body: JSON.stringify({
          to: email,
          subject: "Your booking link — Happens By Chance",
          html,
        }),
      }
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[admin] send booking-pass error:", err?.message);
    return NextResponse.json(
      { error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
