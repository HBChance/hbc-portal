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

  return {
  eventType,
  inviteeEmail,
  calendlyInviteeUri,
  calendlyEventUri,
  startTime,
  endTime,
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

  console.log(
    "[calendly] received:",
    JSON.stringify({
      eventType: parsed.eventType,
      inviteeEmail: parsed.inviteeEmail,
      startTime: parsed.startTime,
      hasInviteeUri: !!parsed.calendlyInviteeUri,
      hasEventUri: !!parsed.calendlyEventUri,
      topKeys: parsed.topKeys,
      payloadKeys: parsed.payloadKeys,
    })
  );

  const supabase = createSupabaseAdminClient();

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
        p_email: parsed.inviteeEmail,
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
            .eq("email", parsed.inviteeEmail)
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
// Consume booking pass ONLY on successful RSVP credit redemption (not on link click)
if (token) {
  const { error: passUpdErr } = await supabase
    .from("booking_passes")
    .update({ used_at: new Date().toISOString() })
    .eq("token", token)
    .is("used_at", null);

  if (passUpdErr) {
    console.error("[calendly] failed to mark booking pass used", passUpdErr.message);
  }
}

    // ✅ Redemption succeeded — now we debug waiver triggering (no behavior change yet)
        // Waiver send (Phase 1D) — only after credited booking success
    try {
      const waiverYear = new Date().getFullYear();
      const emailLower = (parsed.inviteeEmail ?? "").toLowerCase().trim();

      console.log("[waiver] post-booking check start", { email: emailLower, waiverYear });
      console.log("[waiver] signnow module check", {
        copyType: typeof signNow.signNowCopyTemplateToDocument,
        inviteType: typeof signNow.signNowSendDocumentInvite,
      });

      if (!emailLower) {
        console.warn("[waiver] missing inviteeEmail — cannot send waiver");
        return;
      }

      // Check existing waiver row for this email + year
      const { data: existing, error: wErr } = await supabase
        .from("waivers")
        .select("status,sent_at,signed_at,external_document_id")
        .eq("recipient_email", emailLower)
        .eq("waiver_year", waiverYear)
        .maybeSingle();

      if (wErr) {
        console.error("[waiver] lookup error", wErr.message);
        return;
      }

      console.log("[waiver] lookup result", existing ?? null);

      // Idempotency: if already signed or already sent, do nothing
      if (existing?.status === "signed" || existing?.signed_at) {
        console.log("[waiver] already signed — no send", { email: emailLower, waiverYear });
        return;
      }
      if (existing?.status === "sent" && existing?.external_document_id) {
        console.log("[waiver] already sent — no send", { email: emailLower, waiverYear });
        return;
      }

      console.log("[waiver] attempting SignNow send", { email: emailLower, waiverYear });

      const templateId = process.env.SIGNNOW_WAIVER_TEMPLATE_ID;
      const fromEmail = process.env.SIGNNOW_FROM_EMAIL;
      const roleName = process.env.SIGNNOW_WAIVER_ROLE_NAME || "Participant";

      if (!templateId || !fromEmail) {
        console.error("[waiver] missing SIGNNOW env vars", {
          SIGNNOW_WAIVER_TEMPLATE_ID: !!templateId,
          SIGNNOW_FROM_EMAIL: !!fromEmail,
        });
        return;
      }

      // Create doc from template + invite
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
          // If this email belongs to an existing member, attach member_id so /admin recognizes it
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
          ? [memberMatch.first_name, memberMatch.last_name]
              .filter(Boolean)
              .join(" ")
              .trim() || null
          : null;

      const nowIso = new Date().toISOString();

      // Upsert waiver row as sent (unique index ensures one per year)
      const { error: upErr } = await supabase
        .from("waivers")
        .upsert(
          {
            waiver_year: waiverYear,
            status: "sent",
            recipient_email: emailLower,
            recipient_name: recipientName,
            external_provider: "signnow",
            external_document_id: documentId,
            sent_at: nowIso,
            member_id: memberMatch?.id ?? null,
          },
          { onConflict: "recipient_email,waiver_year" }
        );

      if (upErr) {
        console.error("[waiver] upsert sent failed", upErr.message);
        return;
      }

      console.log("[waiver] sent OK", { email: emailLower, waiverYear, documentId });
    } catch (e: any) {
      console.error("[waiver] send crash", e?.message);
      // swallow error so Calendly still gets 200 (no retry storm)
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

