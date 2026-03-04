import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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
    const memberId = body?.member_id != null ? String(body.member_id) : null;

    if (!memberId) {
      return NextResponse.json({ error: "Missing member_id" }, { status: 400 });
    }

    // ---- Load member
    const { data: memberRow, error: memberErr } = await admin
      .from("members")
      .select("id,email,membership_active,membership_plan")
      .eq("id", memberId)
      .maybeSingle();

    if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 });
    if (!memberRow) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const email = normalizeEmail(String(memberRow.email ?? ""));
    if (!email) return NextResponse.json({ error: "Member missing email" }, { status: 400 });

    if (memberRow.membership_active) {
      return NextResponse.json({ error: "Member is already active on a membership" }, { status: 400 });
    }

    // ---- Compose email (keep simple + consistent with your rule text)
    const subject = "Membership options — Happens By Chance Sound Healing";
    const html = `
      <p>Thank you for joining us.</p>

      <p>If you’d like to attend regularly, here are the monthly membership options:</p>

      <ul>
        <li><strong>$33/month</strong> — 1 session credit per month</li>
        <li><strong>$66/month</strong> — 4 session credits per month (credits may be shared with guests; member must attend)</li>
      </ul>

      <p>
        If you’d like to start a membership, reply to this email or visit your membership options from your booking link email.
      </p>

      <p>
        With care,<br/>
        Happens By Chance Sound Healing
      </p>
    `;

    // ---- Send email via Edge Function (Resend)
    // IMPORTANT: replace this with your real membership-offer sender function if you already have one.
    // If you don't, we can either:
    //  (A) create a new Edge Function, OR
    //  (B) reuse a generic "send-email" function if you have it.
    //
    // For now, I’m naming it "send-membership-offer". Update the URL if your function name differs.
    const fnBase = "https://vffglvixaokvtdrdpvtd.functions.supabase.co";
    const url = `${fnBase}/send-membership-offer`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-key": mustGetEnv("CRON_INVOKE_KEY"),
      },
      body: JSON.stringify({ to: email, subject, html }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return NextResponse.json(
        { error: `Failed to send email (Edge Function ${resp.status}): ${txt || "unknown"}` },
        { status: 502 }
      );
    }

    // ---- Update last-sent timestamp
       const now = new Date().toISOString();
    const { error: updErr } = await admin
      .from("members")
      .update({ membership_offer_last_sent_at: now })
      .eq("id", memberRow.id);

    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    // ---- Log to membership_offers
    const { error: logErr } = await admin.from("membership_offers").insert({
      member_id: memberRow.id,
      rsvp_id: null,
      session_start: null,
      offer_type: "admin_manual",
      sent_at: now,
    });

    if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[admin] send membership offer error:", err?.message);
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}