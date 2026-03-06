import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function laParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    yyyy: get("year"),
    mm: get("month"),
    dd: get("day"),
    hh: Number(get("hour") || "0"),
  };
}

function laDayRangeUtcIsoForYesterday(now: Date) {
  // Build LA "yesterday 00:00:00" and "today 00:00:00" by using parts,
  // then interpret them as LA local times via Date parsing trick:
  // We'll instead compute by taking LA date parts and shifting by one day in LA.
  //
  // Simpler + robust: compute "today at 00:00 LA" by using UTC Date
  // with the LA date string and "T00:00:00-08:00/-07:00" is hard (DST).
  // So we do: get LA Y/M/D, create a Date from that as if UTC, then adjust
  // by comparing LA noon offsets. (Good enough for our use because we only
  // need a range; Supabase timestamptz comparisons are UTC.)

  // Practical approach: use "yesterday" & "today" boundaries by querying
  // for session_start in [yesterday 00:00 LA, today 00:00 LA) using
  // Postgres' timezone conversion via RPC would be ideal, but we’ll keep it in TS:
  //
  // We’ll compute LA midnight by taking now, converting to LA date, then
  // constructing a Date at that LA date 00:00 by iterating from now backwards
  // until LA hour==0 and minute==0 (approx). To keep this simple and reliable,
  // we’ll just query a wider window (36h) and filter in-code by LA day.

  return null;
}

serve(async (req) => {
  try {
    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    // ---- Auth: CRON key required
    const cronKey = req.headers.get("x-cron-key");
    const expected = Deno.env.get("CRON_INVOKE_KEY");
    if (!expected) return json(500, { error: "Missing CRON_INVOKE_KEY secret" });
    if (!cronKey || cronKey !== expected) return json(401, { error: "Unauthorized" });

    const now = new Date();
const la = laParts(now);

const body = await req.json().catch(() => ({} as any));
const force = body?.force === true;
const testTo = body?.test_to ? String(body.test_to).trim().toLowerCase() : null;

// SECURITY: only allow force when running a test email
if (force && !testTo) {
  return json(403, { error: "force is only allowed when test_to is provided" });
}

// ✅ TEST MODE: if test_to is provided, send the EXACT attendee email template to that address and exit.
// This bypasses checkins/RSVPs so you can preview the real email content.
if (testTo) {
  const firstName = "Chandler"; // preview name
  const subject = "How was your sound bath? (30 seconds)";
  const html = `
    <p>Hi ${firstName},</p>
    <p>Thank you for joining us yesterday. If you’re open to it, I’d love quick feedback:</p>

    <p><strong>Reply to this email</strong> with:</p>
    <ul>
      <li>1–2 sentences about how you feel today</li>
      <li>Anything you’d love more/less of next time</li>
    </ul>

    <p>With care,<br/>Happens By Chance Sound Healing</p>
  `;

  const mailerUrl = "https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass";
  const mailerCronKey = Deno.env.get("CRON_INVOKE_KEY");
  if (!mailerCronKey) return json(500, { error: "Missing CRON_INVOKE_KEY" });

  const resp = await fetch(mailerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-key": mailerCronKey,
    },
    body: JSON.stringify({
      from: Deno.env.get("FEEDBACK_FROM") || null,
      to: testTo,
      subject,
      html,
    }),
  });

  const details = await resp.text().catch(() => "");
  if (!resp.ok) return json(502, { error: `mailer ${resp.status}`, details });

  return json(200, { ok: true, test: true, to: testTo });
}
// Only send at 9am PT unless force=true
if (!force && la.hh !== 9) {
  return json(200, { ok: true, skipped: true, reason: "not_9am_pt", la_hour: la.hh });
}

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Pull approved check-ins from the last ~36 hours and filter to "yesterday" in LA.
    const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

    const { data: checkins, error } = await db
      .from("checkins")
      .select("rsvp_id, member_id, session_start")
      .eq("entry_approved", true)
      .gte("session_start", since)
      .not("rsvp_id", "is", null)
      .limit(5000);

    if (error) return json(500, { error: error.message });

    // Load RSVPs for these checkins
    const rsvpIds = Array.from(new Set((checkins ?? []).map((c: any) => c.rsvp_id).filter(Boolean)));
    if (rsvpIds.length === 0) return json(200, { ok: true, sent: 0, reason: "no_recent_checkins" });

    const { data: rsvps, error: rsvpErr } = await db
      .from("rsvps")
      .select("id, invitee_email, invitee_name, is_minor, event_start_at")
      .in("id", rsvpIds);

    if (rsvpErr) return json(500, { error: rsvpErr.message });

    // Determine "yesterday" date in LA
    const todayKey = `${la.yyyy}-${la.mm}-${la.dd}`;
    // compute yesterdayKey by creating a Date at UTC noon and subtract a day, then read LA parts
    const noonUtc = new Date(Date.UTC(Number(la.yyyy), Number(la.mm) - 1, Number(la.dd), 12, 0, 0));
    const yNoonUtc = new Date(noonUtc.getTime() - 24 * 60 * 60 * 1000);
    const y = laParts(yNoonUtc);
    const yesterdayKey = `${y.yyyy}-${y.mm}-${y.dd}`;

    // Existing sends (idempotency)
    const { data: already, error: aErr } = await db
      .from("session_feedback_emails")
      .select("rsvp_id")
      .in("rsvp_id", rsvpIds);

    if (aErr) return json(500, { error: aErr.message });

    const alreadySet = new Set((already ?? []).map((x: any) => x.rsvp_id));

    const rsvpById = new Map((rsvps ?? []).map((r: any) => [r.id, r]));

    let sent = 0;
    let skipped = 0;

    for (const c of checkins ?? []) {
      const r = rsvpById.get(c.rsvp_id);
      if (!r) { skipped++; continue; }
      if (!r.invitee_email) { skipped++; continue; }
      if (r.is_minor === true) { skipped++; continue; }
      if (alreadySet.has(c.rsvp_id)) { skipped++; continue; }

      // Only yesterday sessions in LA (based on r.event_start_at)
      const ev = new Date(r.event_start_at);
      const evLa = laParts(ev);
      const evKey = `${evLa.yyyy}-${evLa.mm}-${evLa.dd}`;
      if (evKey !== yesterdayKey) { skipped++; continue; }

      const firstName =
        String(r.invitee_name ?? "").trim().split(" ")[0] || "there";

      const subject = "How was your sound bath? (30 seconds)";
      const html = `
        <p>Hi ${firstName},</p>
        <p>Thank you for joining us yesterday. If you’re open to it, I’d love quick feedback:</p>

        <p><strong>Reply to this email</strong> with:</p>
        <ul>
          <li>1–2 sentences about how you feel today</li>
          <li>Anything you’d love more/less of next time</li>
        </ul>

       <p>With care,<br/>Happens By Chance Sound Healing</p>
      `;

// Send via your existing mailer Edge Function (known-good)
const mailerUrl = "https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass";
const mailerCronKey = Deno.env.get("CRON_INVOKE_KEY");
if (!mailerCronKey) return json(500, { error: "Missing CRON_INVOKE_KEY" });

const toEmail = String(r.invitee_email).trim().toLowerCase();

const resp = await fetch(mailerUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-cron-key": mailerCronKey,
  },
body: JSON.stringify({
  from: Deno.env.get("FEEDBACK_FROM") || null,
  to: toEmail,
  subject,
  html,
}),
});

const details = await resp.text().catch(() => "");

if (!resp.ok) {
  await db.from("session_feedback_emails").insert({
    rsvp_id: c.rsvp_id,
    member_id: c.member_id ?? null,
    invitee_email: toEmail,
    session_start: c.session_start,
    status: "failed",
    error: `mailer ${resp.status}: ${details}`.slice(0, 1000),
  });
  alreadySet.add(c.rsvp_id);
  skipped++;
  continue;
}
      // Log success
      await db.from("session_feedback_emails").insert({
  rsvp_id: c.rsvp_id,
  member_id: c.member_id ?? null,
  invitee_email: toEmail,
  session_start: c.session_start,
  status: "sent",
});

      alreadySet.add(c.rsvp_id);
      sent++;
    }

    return json(200, { ok: true, sent, skipped, yesterdayKey });
  } catch (e: any) {
    return json(500, { error: e?.message || "Unknown error" });
  }
});