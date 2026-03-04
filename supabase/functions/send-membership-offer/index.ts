import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type Payload = {
  to: string;
  subject: string;
  html: string;
};

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  try {
    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    // Auth: same pattern as your other functions (CRON_INVOKE_KEY header)
    const cronKey = req.headers.get("x-cron-key");
    const expected = Deno.env.get("CRON_INVOKE_KEY");
    if (!expected) return json(500, { error: "Missing CRON_INVOKE_KEY" });
    if (!cronKey || cronKey !== expected) return json(401, { error: "Unauthorized" });

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return json(500, { error: "Missing RESEND_API_KEY" });

    const body = (await req.json().catch(() => null)) as Payload | null;
    if (!body?.to || !body?.subject || !body?.html) {
      return json(400, { error: "Missing to/subject/html" });
    }

    const from = Deno.env.get("RESEND_FROM") || "Happens By Chance <help@happensbychance.com>";

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: body.to,
        subject: body.subject,
        html: body.html,
      }),
    });

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      return json(502, { error: `Resend error (${resp.status})`, details: text });
    }

    return json(200, { ok: true });
  } catch (e: any) {
    return json(500, { error: e?.message || "Unknown error" });
  }
});