import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import * as signNow from "@/lib/signnow";

/**
 * Door check-in endpoint (QR -> POST).
 *
 * Body:
 *   { email: string, sessionStart: string }  // sessionStart = ISO string
 *
 * Security:
 *   requires token query param: /api/checkin?token=...
 *   env: CHECKIN_TOKEN
 *
 * Behavior:
 * - Finds RSVP for invitee_email + sessionStart window (±6 hours), status='booked'
 * - Allows check-in starting 1 hour before event_start_at (admin button can bypass later)
 * - Verifies waiver signed for current year; if not signed:
 *     - re-sends existing SignNow invite if a waiver doc exists
 *     - or sends a fresh waiver invite if none exists
 *     - records checkins row with entry_approved=false, waiver_verified=false, denied_reason
 * - If no RSVP: sends $45 purchase link email + records denied checkin row
 * - If approved: records checkins row entry_approved=true, waiver_verified=true
 * - Upsell (membership unlock email) is NOT done here yet; we’ll add after this endpoint is stable.
 */

const LINKS = {
  supportEmail: "membership@happensbychance.com",
  firstSessionLink: "https://buy.stripe.com/00w3cocLh4Ra3eW1oD3Ru05",
  oneSessionMembershipLink: "https://buy.stripe.com/7sY14g6mT4Ra7vcebp3Ru07",
  fourSessionMembershipLink: "https://buy.stripe.com/4gMfZabHdgzSdTAebp3Ru08",
};

function normEmail(v: string) {
  return v.trim().toLowerCase();
}
function fmtLa(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
}

async function sendEmail(to: string, subject: string, html: string) {
  const cronKey = process.env.CRON_INVOKE_KEY;
  if (!cronKey) {
    console.error("[checkin] CRON_INVOKE_KEY missing; email not sent", { to, subject });
    return { ok: false, error: "CRON_INVOKE_KEY missing" };
  }

  const res = await fetch(
    "https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-key": cronKey,
      },
      body: JSON.stringify({ to, subject, html }),
    }
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[checkin] sendEmail failed", { status: res.status, text });
    return { ok: false, error: `mailer_failed_${res.status}` };
  }

  console.log("[checkin] sendEmail ok", { to, subject });
  return { ok: true };
}
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const expected = process.env.CHECKIN_TOKEN;

  if (!expected) {
    console.error("[checkin] CHECKIN_TOKEN missing in env");
    return json(false, { error: "Server misconfigured" }, 500);
  }
  if (!token) {
    // Don’t say “Unauthorized” (per your preference).
    return json(
      false,
      {
        error: "MISSING_TOKEN",
        message:
          "Missing session QR token. Please scan the session QR code again (or ask the coordinator for help).",
      },
      400
    );
  }

  if (token !== expected) {
    return json(
      false,
      {
        error: "INVALID_TOKEN",
        message:
          "Invalid session QR token. Please scan the session QR code again (or ask the coordinator for help).",
      },
      400
    );
  }

  const supabase = createSupabaseAdminClient();

  const body = await req.json().catch(() => null);
  const emailRaw = String(body?.email ?? "");
  const email = normEmail(emailRaw);

  const sessionStartRaw = String(body?.sessionStart ?? "");
  const sessionStartMs = Date.parse(sessionStartRaw);

  if (!email || !email.includes("@")) {
    return json(false, { error: "Valid email is required." }, 400);
  }
  if (!sessionStartRaw || !Number.isFinite(sessionStartMs)) {
    return json(false, { error: "Valid sessionStart (ISO) is required." }, 400);
  }

  const sessionStartIso = new Date(sessionStartMs).toISOString();
  const nowMs = Date.now();

  console.log("[checkin] request", { email, sessionStartIso });

  // Find the RSVP closest to this sessionStart within a tolerance window (±6 hours)
  const startWindowIso = new Date(sessionStartMs - 6 * 60 * 60 * 1000).toISOString();
  const endWindowIso = new Date(sessionStartMs + 6 * 60 * 60 * 1000).toISOString();

  const { data: rsvp, error: rsvpErr } = await supabase
    .from("rsvps")
    .select("id, member_id, invitee_email, invitee_name, event_start_at, status, redeemed_ledger_id")
    .eq("invitee_email", email)
    .eq("status", "booked")
    .gte("event_start_at", startWindowIso)
    .lte("event_start_at", endWindowIso)
    .order("event_start_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (rsvpErr) {
    console.error("[checkin] rsvp lookup error", rsvpErr.message);
    return json(false, { error: rsvpErr.message }, 500);
  }

  // If no RSVP, deny and email first-session link
if (!rsvp?.id) {
  const sessionLa = fmtLa(sessionStartIso);

  const emailRes = await sendEmail(
    email,
    "No RSVP found — Happens By Chance",
    `
      <p><strong>No RSVP found</strong> for <code>${email}</code> for:</p>
      <p><strong>${sessionLa} (America/Los_Angeles)</strong></p>

      <p>If you’d like to attend this session, please purchase a single session here:</p>

      <p>
        <a href="${LINKS.firstSessionLink}">
          <strong>$45 First Session Link</strong>
        </a>
      </p>

      <p>If you believe this is an error, please speak with the session coordinator or email
        <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.
      </p>
    `
  );

  // Record denied check-in
  await supabase.from("checkins").insert({
    booking_id: null,
    member_id: null,
    session_start: sessionStartIso,
    waiver_year: new Date().getFullYear(),
    waiver_verified: false,
    entry_approved: false,
    denied_reason: "NO_RSVP",
  });

  return json(true, {
    approved: false,
    status: "check-in delayed — no RSVP found",
    message:
      `No RSVP shows for ${email} for ${sessionLa}. ` +
      `A single-session purchase link has been emailed. ` +
      `If you think this is an error, please speak with the session coordinator.`,
    email_sent: emailRes?.ok ?? false,
  });
}

  const eventStartIso = rsvp.event_start_at ? new Date(rsvp.event_start_at).toISOString() : sessionStartIso;
  const eventStartMs = Date.parse(eventStartIso);

  // Enforce check-in window:
// allowed from 60 minutes BEFORE start until 90 minutes AFTER start
const opensAtMs = eventStartMs - 60 * 60 * 1000;
const closesAtMs = eventStartMs + 90 * 60 * 1000;

if (nowMs < opensAtMs) {
  return json(true, {
    approved: false,
    status: "too early",
    message: "Check-in opens 60 minutes before the session start time.",
    opensAt: new Date(opensAtMs).toISOString(),
  });
}

if (nowMs > closesAtMs) {
  return json(true, {
    approved: false,
    status: "check-in closed",
    message: "Check-in is closed for this session (90 minutes after start). Please speak with the session coordinator.",
    closesAt: new Date(closesAtMs).toISOString(),
  });
}

  // Waiver verification for current year
  const waiverYear = new Date().getFullYear();

  // Find ANY signed waiver for this email/year
  const { data: signedForYear, error: signedErr } = await supabase
    .from("waivers")
    .select("id,status,signed_at,external_document_id,external_provider,recipient_email,waiver_year")
    .eq("recipient_email", email)
    .eq("waiver_year", waiverYear)
    .or("status.eq.signed,signed_at.not.is.null")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (signedErr) {
    console.error("[checkin] waiver lookup error", signedErr.message);
    return json(false, { error: signedErr.message }, 500);
  }

  const hasSignedWaiver = !!signedForYear?.id;

  if (!hasSignedWaiver) {
  // If there is a waiver row with a document id (sent previously), re-send invite.
  const { data: anyWaiverRow, error: anyWaiverErr } = await supabase
    .from("waivers")
    .select("id,status,external_document_id,external_provider,recipient_email,waiver_year,sent_at")
    .eq("recipient_email", email)
    .eq("waiver_year", waiverYear)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (anyWaiverErr) {
    console.error("[checkin] waiver row lookup error", anyWaiverErr.message);
  }

  const docId = anyWaiverRow?.external_document_id ?? null;

  let signnowInviteOk = false;

  try {
  if (docId) {
    // Fast path: create a signing link and send via our mailer (avoids SignNow email delays)
    const linkRes = await signNow.signNowCreateSigningLink({ documentId: docId });

    const signingUrl =
      linkRes?.url ||
      linkRes?.link ||
      linkRes?.data?.url ||
      linkRes?.data?.link ||
      null;

    if (!signingUrl) {
      console.error("[checkin] signNowCreateSigningLink missing url", { linkRes });
      await sendEmail(
        email,
        `Waiver required to check in (${waiverYear})`,
        `
          <p><strong>Check-in delayed</strong> — waiver is not confirmed signed for ${waiverYear}.</p>
          <p>We were unable to generate a signing link automatically. Please speak with the session coordinator.</p>
          <p>If you need help, email <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.</p>
        `
      );
    } else {
      await sendEmail(
        email,
        `Waiver required to check in (${waiverYear})`,
        `
          <p><strong>Check-in delayed</strong> — waiver is not confirmed signed for ${waiverYear}.</p>
          <p>Please sign your waiver using this link:</p>
          <p><a href="${signingUrl}"><strong>Sign Waiver Now</strong></a></p>
          <p>If you believe you have already signed, please speak with the session coordinator.</p>
          <p>If you need help, email <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.</p>
        `
      );
    }
  } else {
    // No existing doc on file yet — still email instructions (Calendly flow creates the doc on RSVP)
    await sendEmail(
      email,
      `Waiver required to check in (${waiverYear})`,
      `
        <p><strong>Check-in delayed</strong> — waiver is not confirmed signed for ${waiverYear}.</p>
        <p>Please check your email for a waiver request. If you believe you have already signed, please speak with the session coordinator.</p>
        <p>If you need help, email <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.</p>
      `
    );
  }
} catch (e: any) {
  console.error("[checkin] waiver link/send failed", e?.message);
}

  // Always send *our* email too (instant), telling them what to look for.
  const emailRes = await sendEmail(
    email,
    `Waiver required to check in (${waiverYear}) — Happens By Chance`,
    `
      <p><strong>Check-in delayed</strong> — waiver is not confirmed signed for ${waiverYear}.</p>
      <p>
        We have ${signnowInviteOk ? "re-sent" : "attempted to send"} your waiver request via SignNow.
        Please look for an email with the subject:
        <strong>“Happens By Chance — Waiver Required (${waiverYear})”</strong>.
      </p>
      <p>
        If you believe you have already signed, please speak with the session coordinator.
      </p>
      <p>
        If you don’t see the SignNow email, check spam/junk. For help, email
        <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.
      </p>
    `
  );

  // Record delayed check-in
  await supabase.from("checkins").insert({
    booking_id: null,
    member_id: rsvp.member_id,
    session_start: eventStartIso,
    waiver_year: waiverYear,
    waiver_verified: false,
    entry_approved: false,
    denied_reason: "WAIVER_NOT_SIGNED",
  });

  return json(true, {
    approved: false,
    status: "check-in delayed — waiver not signed",
    message:
      "Check-in delayed — waiver is not confirmed signed. We emailed you instructions. If you believe you have already signed, please speak with the session coordinator.",
    waiver_email_sent: emailRes?.ok ?? false,
    signnow_invite_sent: signnowInviteOk,
  });
}

  // Approved check-in
  await supabase.from("checkins").insert({
    booking_id: null,
    member_id: rsvp.member_id,
    session_start: eventStartIso,
    waiver_year: waiverYear,
    waiver_verified: true,
    entry_approved: true,
    denied_reason: null,
  });

  return json(true, {
    approved: true,
    status: "checked in",
    message: "Checked in successfully. Welcome. Please find your place and enjoy the stand-in sound bowls at your leisure",
    member_id: rsvp.member_id,
    rsvp_id: rsvp.id,
  });
}