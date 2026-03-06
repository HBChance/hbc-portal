import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  const cronKey = Deno.env.get("CRON_INVOKE_KEY") ?? "";
  const gotKey = req.headers.get("x-cron-key") ?? "";
  if (!cronKey || gotKey !== cronKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const EMAIL_FROM = Deno.env.get("EMAIL_FROM");
  const FEEDBACK_FROM = Deno.env.get("FEEDBACK_FROM"); // "Happens By Chance Feedback <feedback@happensbychance.com>"

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return new Response(JSON.stringify({ error: "Missing RESEND_API_KEY or EMAIL_FROM" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = await req.json().catch(() => ({}));
  const to = payload?.to;
  const subject = payload?.subject;
  const html = payload?.html;

  if (!to || !subject || !html) {
    return new Response(JSON.stringify({ error: "Missing to/subject/html" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Optional "from" override:
  // Only allow FEEDBACK_FROM if caller requests exactly that value AND secret exists.
  const requestedFrom = typeof payload?.from === "string" ? payload.from.trim() : "";
  const fromFinal =
    requestedFrom && FEEDBACK_FROM && requestedFrom === FEEDBACK_FROM
      ? FEEDBACK_FROM
      : EMAIL_FROM;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromFinal,
      to,
      subject,
      html,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  return new Response(JSON.stringify({ ok: resp.ok, status: resp.status, data }, null, 2), {
    status: resp.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});