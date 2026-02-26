import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import * as signNow from "@/lib/signnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 * - Allows check-in starting 60 minutes before event_start_at until 90 minutes after start
 * - Verifies waiver signed for current year
 *   - If DB not marked signed yet, performs LIVE SignNow check for latest doc and marks signed if completed
 *   - If still not signed, emails instant signing link (via SignNow link + your mailer), with cooldown
 * - If no RSVP: sends $45 purchase link email + records denied checkin row
 * - If approved: records checkins row entry_approved=true, waiver_verified=true
 * - After successful check-in: sends a membership offer email to non-subscribing members
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

function looksCompleted(doc: any): boolean {
  const s = (v: any) => String(v ?? "").toLowerCase();

  const status =
    s(doc?.status) ||
    s(doc?.document_status) ||
    s(doc?.state) ||
    s(doc?.data?.status) ||
    s(doc?.data?.document_status) ||
    s(doc?.data?.state);

  if (
    status.includes("completed") ||
    status.includes("complete") ||
    status.includes("signed") ||
    status.includes("fulfilled") ||
    status.includes("done")
  ) {
    return true;
  }

  if (doc?.is_completed === true || doc?.completed === true) return true;
  if (doc?.data?.is_completed === true || doc?.data?.completed === true) return true;

  const allSignedLike = (arr: any) => {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    return arr.every((x: any) => {
      const st = s(x?.status ?? x?.signing_status ?? x?.state);
      return x?.signed === true || st.includes("signed") || st.includes("complete") || st.includes("fulfilled");
    });
  };

  const invites = doc?.invites ?? doc?.data?.invites ?? null;
  const signers = doc?.signers ?? doc?.data?.signers ?? null;
  const recipients = doc?.recipients ?? doc?.data?.recipients ?? null;
  if (allSignedLike(invites) || allSignedLike(signers) || allSignedLike(recipients)) return true;

  const fieldInvites = doc?.field_invites ?? doc?.data?.field_invites ?? null;
  if (allSignedLike(fieldInvites)) return true;

  return false;
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

  const res = await fetch("https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-key": cronKey,
    },
    body: JSON.stringify({ to, subject, html }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[checkin] sendEmail failed", { status: res.status, text });
    return { ok: false, error: `mailer_failed_${res.status}` };
  }

  console.log("[checkin] sendEmail ok", { to, subject });
  return { ok: true };
}

async function maybeSendMembershipOffer(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  memberId: string;
  rsvpInviteeEmail: string | null;
  rsvpInviteeName?: string | null;
  isMinor?: boolean | null;
}) {
  const { supabase, memberId, rsvpInviteeEmail, rsvpInviteeName, isMinor } = opts;

  // Never send to minors (guests)
  if (isMinor === true) {
    return { attempted: false, sent: false, reason: "minor_guest" as const };
  }

  // Load member record
  const { data: mRow, error: mErr } = await supabase
    .from("members")
    .select("email,first_name,last_name,membership_active,membership_offer_last_sent_at")
    .eq("id", memberId)
    .maybeSingle();

  if (mErr) {
    console.warn("[checkin] membership-offer: member lookup error", mErr.message);
    return { attempted: false, sent: false, reason: "member_lookup_failed" as const };
  }

  const memberEmail = mRow?.email ? normEmail(String(mRow.email)) : null;
  if (!memberEmail) return { attempted: false, sent: false, reason: "member_missing_email" as const };

  // If this RSVP is for a guest (invitee email != member email), do not send membership offer.
  const inviteeEmailNorm = rsvpInviteeEmail ? normEmail(String(rsvpInviteeEmail)) : null;
  if (!inviteeEmailNorm || inviteeEmailNorm !== memberEmail) {
    return { attempted: false, sent: false, reason: "guest_rsvp" as const };
  }

  // If they are an active subscriber, do not send.
  if ((mRow as any)?.membership_active === true) {
    return { attempted: false, sent: false, reason: "active_subscriber" as const };
  }

  const firstName =
    String((mRow as any)?.first_name ?? "").trim() ||
    String(rsvpInviteeName ?? "").trim().split(" ")[0] ||
    "there";

  const emailRes = await sendEmail(
  memberEmail,
  "Membership Pricing — Choose Your Monthly Plan",
  `
    <p>Hi ${firstName},</p>

    <p>Your check-in has unlocked your membership offers!</p>

    <p>If you’d like to continue as a <strong>supporting member</strong>, choose a monthly plan below:</p>

    <ul>
      <li>
        <a href="${LINKS.oneSessionMembershipLink}">
          <strong>$33/month — 1 session</strong>
        </a>
      </li>

      <li>
        <a href="${LINKS.fourSessionMembershipLink}">
          <strong>$66/month — 4 sessions</strong>
        </a>
        <span style="color:#64748b;"> (best value if you plan to come weekly)</span>
        <ul style="margin-top:6px;">
          <li style="color:#64748b;">
            Credits may be shared with family & friends.
          </li>
        </ul>
      </li>
    </ul>

    <p style="color:#64748b;">
      Questions? Email
      <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.
    </p>
  `
);

  // Store last sent (for audit/future logic; not used as a cooldown)
  try {
    const nowIso = new Date().toISOString();
    await supabase
      .from("members")
      .update({ membership_offer_last_sent_at: nowIso, updated_at: nowIso })
      .eq("id", memberId);
  } catch (e: any) {
    console.warn("[checkin] membership-offer: failed to update last_sent", e?.message);
  }

  return { attempted: true, sent: emailRes?.ok ?? false, reason: "sent_or_failed" as const };
}

export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const expected = process.env.CHECKIN_TOKEN;

  if (!expected) {
    console.error("[checkin] CHECKIN_TOKEN missing in env");
    return json(false, { error: "Server misconfigured" }, 500);
  }

  if (!token) {
    return json(
      false,
      {
        error: "MISSING_TOKEN",
        message: "Missing session QR token. Please scan the session QR code again (or ask the coordinator for help).",
      },
      400
    );
  }

  if (token !== expected) {
    return json(
      false,
      {
        error: "INVALID_TOKEN",
        message: "Invalid session QR token. Please scan the session QR code again (or ask the coordinator for help).",
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

  if (!email || !email.includes("@")) return json(false, { error: "Valid email is required." }, 400);
  if (!sessionStartRaw || !Number.isFinite(sessionStartMs))
    return json(false, { error: "Valid sessionStart (ISO) is required." }, 400);

  const sessionStartIso = new Date(sessionStartMs).toISOString();
  const nowMs = Date.now();

  console.log("[checkin] request", { email, sessionStartIso });

  // RSVP tolerance window (±6 hours)
  const startWindowIso = new Date(sessionStartMs - 6 * 60 * 60 * 1000).toISOString();
  const endWindowIso = new Date(sessionStartMs + 6 * 60 * 60 * 1000).toISOString();

  const { data: rsvps, error: rsvpErr } = await supabase
    .from("rsvps")
    .select("id, member_id, invitee_email, invitee_name, is_minor, event_start_at, status, redeemed_ledger_id")
    .eq("invitee_email", email)
    .eq("status", "booked")
    .gte("event_start_at", startWindowIso)
    .lte("event_start_at", endWindowIso)
    .order("event_start_at", { ascending: true })
    .limit(10);

  if (rsvpErr) {
    console.error("[checkin] rsvp lookup error", rsvpErr.message);
    return json(false, { error: rsvpErr.message }, 500);
  }

  const rsvp =
    (rsvps ?? [])
      .filter((x: any) => x?.event_start_at)
      .sort((a: any, b: any) => {
        const da = Math.abs(Date.parse(a.event_start_at) - sessionStartMs);
        const db = Math.abs(Date.parse(b.event_start_at) - sessionStartMs);
        return da - db;
      })[0] ?? null;

  // No RSVP
  if (!rsvp?.id) {
    const sessionLa = fmtLa(sessionStartIso);

    const emailRes = await sendEmail(
      email,
      "No RSVP found — Happens By Chance",
      `
        <p><strong>No RSVP found</strong> for <code>${email}</code> for:</p>
        <p><strong>${sessionLa} (America/Los_Angeles)</strong></p>
        <p>If you’d like to attend this session, please purchase a single session here:</p>
        <p><a href="${LINKS.firstSessionLink}"><strong>$45 First Session Link</strong></a></p>
        <p>If you believe this is an error, please speak with the session coordinator or email
          <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.
        </p>
      `
    );

    await supabase.from("checkins").insert({
      rsvp_id: null,
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

  // allowed from 60 min before until 90 min after
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

  const waiverYear = new Date().getFullYear();

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

  let hasSignedWaiver = !!signedForYear?.id;

  // LIVE SignNow check if DB not signed yet
  if (!hasSignedWaiver) {
    const { data: latestWaiverRow, error: latestErr } = await supabase
      .from("waivers")
      .select("id, external_document_id, status, waiver_year, sent_at")
      .eq("recipient_email", email)
      .eq("waiver_year", waiverYear)
      .not("external_document_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestErr && latestWaiverRow?.external_document_id) {
      const docId = String(latestWaiverRow.external_document_id).trim();

      try {
        const doc = await signNow.signNowGetDocument(docId);

        console.log("[checkin] signnow doc summary", {
          docId,
          status: doc?.status ?? null,
          document_status: doc?.document_status ?? null,
          state: doc?.state ?? null,
          is_completed: doc?.is_completed ?? null,
          completed: doc?.completed ?? null,
          data_status: doc?.data?.status ?? null,
          data_document_status: doc?.data?.document_status ?? null,
          data_state: doc?.data?.state ?? null,
          data_is_completed: doc?.data?.is_completed ?? null,
          data_completed: doc?.data?.completed ?? null,
          field_invites_len: Array.isArray(doc?.field_invites) ? doc.field_invites.length : null,
          invites_len: Array.isArray(doc?.invites) ? doc.invites.length : null,
          signers_len: Array.isArray(doc?.signers) ? doc.signers.length : null,
          recipients_len: Array.isArray(doc?.recipients) ? doc.recipients.length : null,
        });

        if (looksCompleted(doc)) {
          const nowIso = new Date().toISOString();
          const { error: upErr } = await supabase
            .from("waivers")
            .update({
              status: "signed",
              signed_at: nowIso,
              updated_at: nowIso,
            })
            .eq("id", latestWaiverRow.id);

          if (!upErr) {
            hasSignedWaiver = true;
            console.log("[checkin] live waiver check: MARKED SIGNED", { waiverId: latestWaiverRow.id, docId });
          } else {
            console.warn("[checkin] live waiver check: failed to update waiver row", upErr.message);
          }
        } else {
          console.log("[checkin] live waiver check: not completed", { waiverId: latestWaiverRow.id, docId });
        }
      } catch (e: any) {
        console.warn("[checkin] live waiver check: signnow fetch failed", e?.message);
      }
    }
  }

  // Still not signed → send instant signing link (cooldown)
  if (!hasSignedWaiver) {
    const cooldownStartIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { count: recentDeniedCount } = await supabase
      .from("checkins")
      .select("id", { count: "exact", head: true })
      .eq("member_id", rsvp.member_id)
      .eq("session_start", eventStartIso)
      .eq("denied_reason", "WAIVER_NOT_SIGNED")
      .gte("created_at", cooldownStartIso);

    const recentlyReminded = (recentDeniedCount ?? 0) > 0;

    let waiverEmailSent = false;

    if (!recentlyReminded) {
      const { data: anyWaiverRow } = await supabase
        .from("waivers")
        .select("external_document_id, sent_at")
        .eq("recipient_email", email)
        .eq("waiver_year", waiverYear)
        .not("external_document_id", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const docId = anyWaiverRow?.external_document_id ?? null;

      if (docId) {
        try {
          const linkRes = await signNow.signNowCreateSigningLink({ documentId: docId });
          const signingUrl = linkRes?.url || linkRes?.link || linkRes?.data?.url || linkRes?.data?.link || null;

          if (signingUrl) {
            const emailRes = await sendEmail(
              email,
              `Waiver required to check in (${waiverYear}) — Happens By Chance`,
              `
                <p><strong>Check-in delayed</strong> — waiver is not confirmed signed for ${waiverYear}.</p>
                <p>Please sign your waiver using this link:</p>
                <p><a href="${signingUrl}"><strong>Sign Waiver Now</strong></a></p>
                <p>If you believe you have already signed, please speak with the session coordinator.</p>
                <p>If you need help, email <a href="mailto:${LINKS.supportEmail}">${LINKS.supportEmail}</a>.</p>
              `
            );
            waiverEmailSent = emailRes?.ok ?? false;
          } else {
            console.error("[checkin] create signing link returned no url", { linkRes });
          }
        } catch (e: any) {
          console.error("[checkin] waiver signing-link email failed", e?.message);
        }
      } else {
        console.log("[checkin] no waiver doc id found for year; cannot generate signing link", { email, waiverYear });
      }
    } else {
      console.log("[checkin] waiver reminder suppressed (cooldown)", {
        email,
        waiverYear,
        memberId: rsvp.member_id,
        session_start: eventStartIso,
      });
    }

    await supabase.from("checkins").insert({
      rsvp_id: rsvp.id,
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
        "Check-in delayed — waiver is not confirmed signed. We emailed your waiver link. If you believe you have already signed, please speak with the session coordinator.",
      waiver_email_sent: waiverEmailSent,
    });
  }

  // Approved check-in insert (idempotent-ish: we allow multiple, but it’s okay operationally)
  const { error: ckErr } = await supabase.from("checkins").insert({
    rsvp_id: rsvp.id,
    booking_id: null,
    member_id: rsvp.member_id,
    session_start: eventStartIso,
    waiver_year: waiverYear,
    waiver_verified: true,
    entry_approved: true,
    denied_reason: null,
  });

  if (ckErr) {
    console.error("[checkin] failed to insert approved checkin", ckErr.message);
    // Still let them in; don’t block entry on logging failure.
  }

  // Membership offer (best-effort, never blocks check-in)
  try {
    const offerRes = await maybeSendMembershipOffer({
  supabase,
  memberId: rsvp.member_id,
  rsvpInviteeEmail: rsvp.invitee_email ?? null,
  rsvpInviteeName: rsvp.invitee_name ?? null,
  isMinor: (rsvp as any).is_minor ?? null,
});
    console.log("[checkin] membership-offer", { memberId: rsvp.member_id, ...offerRes });
  } catch (e: any) {
    console.warn("[checkin] membership-offer failed", e?.message);
  }

  return json(true, {
    approved: true,
    status: "checked in",
    message: "Checked in successfully. Welcome. Please find your place and enjoy the stand-in sound bowls at your leisure",
    member_id: rsvp.member_id,
    rsvp_id: rsvp.id,
  });
}