export const runtime = "nodejs";

import * as signNow from "@/lib/signnow";

import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getQueryToken(req: Request) {
  try {
    const url = new URL(req.url);
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * Your real Calendly webhook body shape (based on your logs):
 * {
 *   event: "invitee.created" | "invitee.canceled",
 *   payload: {
 *     email: "...",
 *     uri: "https://api.calendly.com/scheduled_events/..../invitees/....",
 *     scheduled_event: { uri, start_time, end_time, ... },
 *     ...
 *   }
 * }
 */
function parseCalendly(body: any) {
  const eventType = body?.event ?? body?.event_type ?? body?.eventType ?? null;
  const payload = body?.payload ?? null;

  // In YOUR payload, these are direct keys on payload
  const inviteeEmail =
    payload?.email ??
    payload?.email_address ??
    body?.inviteeEmail ??
    null;

  const calendlyInviteeUri =
    payload?.uri ??
    payload?.invitee?.uri ??
    null;

  const calendlyEventUri =
    payload?.scheduled_event?.uri ??
    payload?.event?.uri ??
    null;

  const startTime =
    payload?.scheduled_event?.start_time ??
    payload?.scheduled_event?.startTime ??
    payload?.event?.start_time ??
    null;

  const endTime =
    payload?.scheduled_event?.end_time ??
    payload?.scheduled_event?.endTime ??
    payload?.event?.end_time ??
    null;

   const token =
    (payload?.tracking?.utm_content as string | undefined) ??
    (payload?.tracking?.utm_term as string | undefined) ??
    null;

  return {
    eventType,
    inviteeEmail,
    calendlyInviteeUri,
    calendlyEventUri,
    startTime,
    endTime,
    token,
    topKeys: Object.keys(body ?? {}),
    payloadKeys: payload ? Object.keys(payload) : [],
  };
}

function isInsufficientCredits(message: string | null | undefined) {
  if (!message) return false;
  // Your DB/RPC currently returns "INSUFFICIENT_CREDITS"
  return message.includes("INSUFFICIENT_CREDITS");
}

export async function POST(req: Request) {
  // Token gate
  const token = getQueryToken(req);
  const expected = process.env.CALENDLY_WEBHOOK_TOKEN;

  if (!expected) {
    console.error("[calendly] CALENDLY_WEBHOOK_TOKEN missing in env");
    return jsonResponse({ ok: false, error: "Server misconfigured" }, 500);
  }
  if (!token || token !== expected) {
    console.warn("[calendly] ignored: missing/invalid token");
    return jsonResponse({ ok: true, ignored: "token" }, 200);
  }

  // Read body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const parsed = parseCalendly(body);

console.log("[calendly] parsed identity", {
  eventType: parsed.eventType,
  inviteeEmail: parsed.inviteeEmail,
  calendlyInviteeUri: parsed.calendlyInviteeUri,
  calendlyEventUri: parsed.calendlyEventUri,
  token: parsed.token ?? null,
  topKeys: parsed.topKeys,
  payloadKeys: parsed.payloadKeys,
});

const supabase = createSupabaseAdminClient();

// Default: redeem against the invitee (normal flow)
let redeemEmail = parsed.inviteeEmail;

// If booking-pass token exists, redeem against the PURCHASER email (booking_pass.email)
if (parsed.token) {
  const { data: passRow, error: passErr } = await supabase
    .from("booking_passes")
    .select("email, used_at, expires_at")
    .eq("token", parsed.token)
    .maybeSingle();

  if (passErr) {
    console.error("[calendly] booking_pass lookup failed", passErr.message);
  } else if (!passRow) {
    console.warn("[calendly] booking_pass not found for token", { token: parsed.token });
  } else if (passRow.used_at) {
    console.warn("[calendly] booking_pass already used", { token: parsed.token });
  } else if (passRow.expires_at && Date.parse(passRow.expires_at) <= Date.now()) {
    console.warn("[calendly] booking_pass expired", { token: parsed.token });
  } else if (passRow.email) {
    redeemEmail = String(passRow.email).toLowerCase().trim();
  }
}

// We’ll need this later in the success path to correct RSVP guest email
// (RPC probably records invitee_email = redeemEmail)
const guestEmail = parsed.inviteeEmail;

  try {
    if (parsed.eventType === "invitee.created") {
      if (
        !parsed.inviteeEmail ||
        !parsed.calendlyEventUri ||
        !parsed.calendlyInviteeUri ||
        !parsed.startTime
      ) {
        console.warn("[calendly] missing required fields for created", {
          inviteeEmail: parsed.inviteeEmail,
          calendlyEventUri: parsed.calendlyEventUri,
          calendlyInviteeUri: parsed.calendlyInviteeUri,
          startTime: parsed.startTime,
        });
        return jsonResponse({ ok: true, ignored: "missing_fields_created" }, 200);
      }
      const { data, error } = await supabase.rpc("redeem_credit_for_calendly", {
        p_email: redeemEmail,
        p_calendly_event_uri: parsed.calendlyEventUri,
        p_calendly_invitee_uri: parsed.calendlyInviteeUri,
        p_event_start_at: parsed.startTime,
        p_event_end_at: parsed.endTime,
      });

      if (error) {
        console.error("[calendly] redeem_credit_for_calendly error:", error.message);

        // NEW: If insufficient credits, record an issue row for admin visibility
        if (isInsufficientCredits(error.message)) {
          let member_id: string | null = null;

          // Best-effort: link to member if they exist
          const { data: member } = await supabase
            .from("members")
            .select("id")
            .eq("email", redeemEmail)
            .maybeSingle();

          member_id = member?.id ?? null;

          const upsertPayload = {
            calendly_invitee_uri: parsed.calendlyInviteeUri,
            calendly_event_uri: parsed.calendlyEventUri,
            invitee_email: parsed.inviteeEmail,
            member_id,
            event_start_at: parsed.startTime,
            event_end_at: parsed.endTime,
            error_code: "INSUFFICIENT_CREDITS",
            error_message: error.message,
          };

          const { error: issueErr } = await supabase
            .from("calendly_booking_issues")
            .upsert(upsertPayload, { onConflict: "calendly_invitee_uri" });

          if (issueErr) {
            console.error("[calendly] failed to log booking issue:", issueErr.message);
          } else {
            console.log("[calendly] logged booking issue (INSUFFICIENT_CREDITS):", {
              invitee: parsed.inviteeEmail,
              start: parsed.startTime,
            });
          }
        }

           // Always 200 so Calendly doesn't hammer retries forever (your current behavior)
      return jsonResponse({ ok: true, error: error.message }, 200);
    }
// After successful redemption, store attendee name on the RSVP row for /admin display
const attendeeName =
  String(body?.payload?.name ?? "").trim() ||
  [body?.payload?.first_name, body?.payload?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim() ||
  null;

if (parsed.calendlyInviteeUri) {
  const { error: rsvpNameErr } = await supabase
    .from("rsvps")
    .update({ invitee_name: attendeeName })
    .eq("calendly_invitee_uri", parsed.calendlyInviteeUri);

  if (rsvpNameErr) {
    console.error("[calendly] failed to set RSVP invitee_name", rsvpNameErr.message);
  } else {
    console.log("[calendly] RSVP invitee_name updated", { attendeeName });
  }
}
// Consume booking pass ONLY on successful RSVP credit redemption (not on link click)
if (parsed.token) {
  const { error: passUpdErr } = await supabase
    .from("booking_passes")
    .update({ used_at: new Date().toISOString() })
    .eq("token", parsed.token)
    .is("used_at", null);

  if (passUpdErr) {
    console.error("[calendly] failed to mark booking pass used", passUpdErr.message);
  }
}
// ✅ Redemption succeeded — waiver send (per Calendly invitee URI, not per email)
try {
  const waiverYear = new Date().getFullYear();
  const emailLower = (parsed.inviteeEmail ?? "").toLowerCase().trim();

  if (!emailLower) {
    console.warn("[waiver] missing inviteeEmail — cannot send waiver");
  } else {
    const calendlyInviteeUri = parsed.calendlyInviteeUri ?? null;

    // Build attendee identity from Calendly payload
const waiverInviteeUri = parsed.calendlyInviteeUri ?? null;

const attendeeName = (() => {
  const direct = String((body?.payload?.name as string | undefined) ?? "").trim();
  if (direct) return direct;

  const first = String(body?.payload?.first_name ?? "").trim();
  const last = String(body?.payload?.last_name ?? "").trim();
  const combined = `${first} ${last}`.trim();
  return combined || null;
})();

// Lookup existing waiver:
// Prefer: calendly_invitee_uri (unique per attendee)
// Fallback: recipient_email + waiver_year (older flow)
let existing: any = null;

if (waiverInviteeUri) {
  const { data: wByUri, error: wErr } = await supabase
    .from("waivers")
    .select("status,sent_at,signed_at,external_document_id,calendly_invitee_uri")
    .eq("calendly_invitee_uri", waiverInviteeUri)
    .maybeSingle();

  if (wErr) {
    console.error("[waiver] lookup error (by uri)", wErr.message);
  } else {
    existing = wByUri ?? null;
  }
} else {
  const { data: wByEmail, error: wErr } = await supabase
    .from("waivers")
    .select("status,sent_at,signed_at,external_document_id")
    .eq("recipient_email", emailLower)
    .eq("waiver_year", waiverYear)
    .maybeSingle();

  if (wErr) {
    console.error("[waiver] lookup error (by email)", wErr.message);
  } else {
    existing = wByEmail ?? null;
  }
}

    // Idempotency
    if (existing?.status === "signed" || existing?.signed_at) {
      console.log("[waiver] already signed — no send", { calendlyInviteeUri, waiverYear });
    } else if (existing?.status === "sent" && existing?.external_document_id) {
      console.log("[waiver] already sent — no send", { calendlyInviteeUri, waiverYear });
    } else {
      const templateId = process.env.SIGNNOW_WAIVER_TEMPLATE_ID;
      const fromEmail = process.env.SIGNNOW_FROM_EMAIL;
      const roleName = process.env.SIGNNOW_WAIVER_ROLE_NAME || "Participant";

      if (!templateId || !fromEmail) {
        console.error("[waiver] missing SIGNNOW env vars", {
          SIGNNOW_WAIVER_TEMPLATE_ID: !!templateId,
          SIGNNOW_FROM_EMAIL: !!fromEmail,
        });
      } else {
        console.log("[waiver] attempting SignNow send", { email: emailLower, waiverYear, calendlyInviteeUri });

        const subject = `Happens By Chance — Annual Waiver (${waiverYear})`;
        const message =
          `Hello,\n\n` +
          `Please sign your annual waiver for ${waiverYear}.\n\n` +
          `— Happens By Chance Health & Wellness`;

        const copy = await signNow.signNowCopyTemplateToDocument({
          templateId,
          documentName: `HBC Waiver ${waiverYear} — ${emailLower}`,
        });

        const documentId = copy.document_id;

        await signNow.signNowSendDocumentInvite({
          documentId,
          fromEmail,
          toEmail: emailLower,
          subject,
          message,
          roleName,
          expirationDays: 30,
        });

        // Attach member_id if email matches an existing member (helps /admin)
        const { data: memberMatch, error: memMatchErr } = await supabase
          .from("members")
          .select("id, first_name, last_name")
          .eq("email", emailLower)
          .maybeSingle();

        if (memMatchErr) {
          console.error("[waiver] member lookup error", memMatchErr.message);
        }

        const recipientName =
          memberMatch
            ? [memberMatch.first_name, memberMatch.last_name].filter(Boolean).join(" ").trim() || null
            : null;

        const nowIso = new Date().toISOString();

        // Upsert waiver row as sent:
        // If we have calendlyInviteeUri, use that uniqueness.
        // Otherwise fall back to email+year uniqueness.
        const waiverRow: any = {
          waiver_year: waiverYear,
          status: "sent",
          recipient_email: emailLower,
          recipient_name: recipientName,
	  calendly_invitee_uri: waiverInviteeUri,
          attendee_name: attendeeName,
          external_provider: "signnow",
          external_document_id: documentId,
          sent_at: nowIso,
          member_id: memberMatch?.id ?? null,
         
        };

        const onConflict = calendlyInviteeUri ? "calendly_invitee_uri" : "recipient_email,waiver_year";

        const { error: upErr } = await supabase
          .from("waivers")
          .upsert(waiverRow, { onConflict });

        if (upErr) {
          console.error("[waiver] upsert sent failed", upErr.message);
        } else {
          console.log("[waiver] sent OK", { email: emailLower, waiverYear, documentId, calendlyInviteeUri });
        }
      }
    }
  }
} catch (e: any) {
  console.error("[waiver] send crash", e?.message);
  // swallow error so Calendly still gets 200 (no retry storm)
}

// If the booking-pass flow was used, the RPC probably wrote invitee_email = redeemEmail.
// Correct the RSVP row to reflect the actual guest attendee email from Calendly.
if (parsed.calendlyInviteeUri && guestEmail && redeemEmail && guestEmail !== redeemEmail) {
  const { error: rsvpFixErr } = await supabase
    .from("rsvps")
    .update({ invitee_email: guestEmail })
    .eq("calendly_invitee_uri", parsed.calendlyInviteeUri);

  if (rsvpFixErr) {
    console.error("[calendly] failed to update RSVP invitee_email to guest", rsvpFixErr.message);
  } else {
    console.log("[calendly] RSVP invitee_email corrected to guest", { guestEmail });
  }
}
    return jsonResponse({ ok: true, redeemed_rsvp_id: data }, 200);
  }

  if (parsed.eventType === "invitee.canceled") {
    if (!parsed.calendlyInviteeUri) {
      console.warn("[calendly] missing invitee uri for canceled");
      return jsonResponse({ ok: true, ignored: "missing_invitee_uri_canceled" }, 200);
    }

    const { data, error } = await supabase.rpc("cancel_rsvp_for_calendly", {
      p_calendly_invitee_uri: parsed.calendlyInviteeUri,
    });

    if (error) {
      console.error("[calendly] cancel_rsvp_for_calendly error:", error.message);
      return jsonResponse({ ok: true, error: error.message }, 200);
    }

    console.log("[calendly] canceled+refunded OK:", data);
    return jsonResponse({ ok: true, canceled_rsvp_id: data }, 200);
  }

  return jsonResponse({ ok: true, ignored: parsed.eventType ?? "unknown" }, 200);
} catch (err: any) {
  console.error("[calendly] handler crash:", err?.message);
  return jsonResponse({ ok: false, error: err?.message }, 500);
}
}

export async function GET() {
return jsonResponse({ ok: true, msg: "Calendly webhook endpoint alive" }, 200);
}

