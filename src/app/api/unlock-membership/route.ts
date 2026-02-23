import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEMBERSHIP = {
  supportEmail: "membership@happensbychance.com",
  firstSessionLink: "https://buy.stripe.com/00w3cocLh4Ra3eW1oD3Ru05",
  oneSession: {
    title: "Ladera Ranch Sound Healing - 1 Session Monthly Membership",
    paymentLink: "https://buy.stripe.com/7sY14g6mT4Ra7vcebp3Ru07",
  },
  fourSession: {
    title: "Ladera Ranch Sound Healing - 4 Session Monthly Membership",
    paymentLink: "https://buy.stripe.com/4gMfZabHdgzSdTAebp3Ru08",
  },
};

// Uses your existing Resend Edge Function
const EMAIL_EDGE_FN =
  "https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass";

function normEmail(v: string) {
  return v.trim().toLowerCase();
}

function isValidEmail(v: string) {
  return v.includes("@") && v.includes(".");
}

async function sendEmail(opts: { to: string; subject: string; html: string }) {
  const cronKey = process.env.CRON_INVOKE_KEY;
  if (!cronKey) throw new Error("Missing CRON_INVOKE_KEY env var");

  const res = await fetch(EMAIL_EDGE_FN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-key": cronKey,
    },
    body: JSON.stringify({
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Email edge function failed (${res.status}): ${text}`);
  }
}

export async function GET() {
  // Prevent noisy 405s from health checks / accidental browser hits
  return NextResponse.json({ ok: true, msg: "unlock-membership endpoint alive" });
}

export async function POST(req: Request) {
  console.log("[unlock-membership] HIT", {
    url: req.url,
    method: req.method,
    ts: new Date().toISOString(),
  });

  const supabase = createSupabaseAdminClient();

  const body = await req.json().catch(() => null);
  const emailRaw = String(body?.email ?? "");
  const email = normEmail(emailRaw);

  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { ok: false, error: "Valid email is required." },
      { status: 400 }
    );
  }

  // RSVP-based eligibility:
  // attendee email must have a past RSVP that is booked AND redeemed.
  const nowIso = new Date().toISOString();

  const { count, error } = await supabase
    .from("rsvps")
    .select("id", { count: "exact", head: true })
    .eq("invitee_email", email)
    .eq("status", "booked")
    .not("redeemed_ledger_id", "is", null)
    .lt("event_start_at", nowIso);

  if (error) {
    console.error("[unlock-membership] eligibility query error", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const eligible = (count ?? 0) > 0;

  const subject = eligible
    ? "Your membership options — Happens By Chance"
    : "First session required — Happens By Chance";

  const htmlEligible = `
    <p>Thanks for being here.</p>

    <p>You’re eligible to enroll in a monthly membership. Choose one:</p>

    <ul>
      <li><strong>${MEMBERSHIP.oneSession.title}</strong><br/>
        <a href="${MEMBERSHIP.oneSession.paymentLink}">Subscribe here</a>
      </li>
      <li style="margin-top:10px;"><strong>${MEMBERSHIP.fourSession.title}</strong><br/>
        <a href="${MEMBERSHIP.fourSession.paymentLink}">Subscribe here</a>
      </li>
    </ul>

    <p><strong>How membership works:</strong></p>
    <ul>
      <li>Your membership renews on the <strong>same day each month</strong> you started.</li>
      <li>Your monthly credits renew on that same day.</li>
      <li>If you ever need extra sessions beyond your monthly credits, purchase a single session.</li>
    </ul>

    <p><strong>Shared credits (important):</strong></p>
    <ul>
      <li><strong>All bookings must be made under the member’s email</strong> (${email}).</li>
      <li>If you’re booking for a guest: use your member email, and put the guest’s name in the name field.</li>
      <li>Each attendee must have a waiver on file. Waiver emails go to the member by default — forward to adult guests, or sign for minors.</li>
    </ul>

    <p><strong>Questions / cancellations:</strong> email
      <a href="mailto:${MEMBERSHIP.supportEmail}">${MEMBERSHIP.supportEmail}</a>.
    </p>
  `;

  const htmlNotEligible = `
    <p>Thanks for reaching out.</p>

    <p>
      Looks like you haven’t attended your first session yet (or it hasn’t been redeemed in our system).
      After attending, you’ll be able to enroll in a membership.
    </p>

    <p>
      <strong>$45 first session link:</strong><br/>
      <a href="${MEMBERSHIP.firstSessionLink}">${MEMBERSHIP.firstSessionLink}</a>
    </p>

    <p>
      If you believe this is an error, email
      <a href="mailto:${MEMBERSHIP.supportEmail}">${MEMBERSHIP.supportEmail}</a>.
    </p>
  `;

  try {
    await sendEmail({
      to: email,
      subject,
      html: eligible ? htmlEligible : htmlNotEligible,
    });

    console.log("[unlock-membership] email sent", {
      to: email,
      eligible,
      rsvp_count: count ?? 0,
    });
  } catch (e: any) {
    console.error("[unlock-membership] email send failed", {
      to: email,
      eligible,
      msg: e?.message,
    });

    return NextResponse.json(
      { ok: false, error: "Failed to send email. Please try again shortly." },
      { status: 500 }
    );
  }

  // Keep UI simple: don't reveal eligibility on-screen.
  return NextResponse.json({ ok: true });
}