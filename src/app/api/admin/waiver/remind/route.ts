import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { signNowSendDocumentInvite } from "@/lib/signnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAIVER_YEAR = new Date().getFullYear();

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();

    // Auth
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await supabase
      .from("members")
      .select("is_admin")
      .eq("user_id", user.id)
      .single();

    if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Input
    const body = await req.json().catch(() => null);
    const member_id = body?.member_id as string | undefined;
    if (!member_id) return NextResponse.json({ error: "member_id required" }, { status: 400 });

    // Load member email/name
    const { data: member, error: memErr } = await supabase
      .from("members")
      .select("id,email,first_name,last_name")
      .eq("id", member_id)
      .single();

    if (memErr) return NextResponse.json({ error: memErr.message }, { status: 400 });
    if (!member?.email) return NextResponse.json({ error: "Member has no email" }, { status: 400 });

    const recipient_email = String(member.email).toLowerCase().trim();
    const recipient_name =
      [member.first_name, member.last_name].filter(Boolean).join(" ").trim() || null;

    // Find all waivers for this member for this year that are NOT signed
    const { data: waivers, error: wErr } = await supabase
      .from("waivers")
      .select("id,status,external_document_id,attendee_name,recipient_email,waiver_year,calendly_invitee_uri")
      .eq("member_id", member_id)
      .eq("waiver_year", WAIVER_YEAR);

    if (wErr) return NextResponse.json({ error: wErr.message }, { status: 400 });

    const pending = (waivers ?? []).filter((w: any) => {
      const status = String(w.status ?? "").toLowerCase();
      return status !== "signed";
    });

    if (pending.length === 0) {
      return NextResponse.json({ error: "No unsigned waivers for this member." }, { status: 409 });
    }

    // Build the “who is unsigned” list for the reminder email
    const names = pending
      .map((w: any) => String(w.attendee_name ?? "").trim())
      .filter(Boolean);

    const uniqueNames = Array.from(new Set(names));

    const listHtml =
      uniqueNames.length > 0
        ? `<ul>${uniqueNames.map((n) => `<li>${n}</li>`).join("")}</ul>`
        : `<p>(Name not captured on one or more waivers — SignNow invite still resent.)</p>`;

    // Send a normal email reminder (single email)
    // Reuse your existing Edge email sender (same endpoint you already use for booking-pass)
    const cronKey = mustGetEnv("CRON_INVOKE_KEY");

    const subject = `Reminder: Please sign your Happens By Chance waiver (${WAIVER_YEAR})`;

    const html = `
      <p>Hello${recipient_name ? ` ${recipient_name}` : ""},</p>
      <p>This is a friendly reminder to sign your annual waiver(s) for ${WAIVER_YEAR}.</p>
      <p><strong>Still unsigned:</strong></p>
      ${listHtml}
      <p>We’ve re-sent the SignNow email invite(s) so you can sign without creating anything new.</p>
      <p>— Happens By Chance Health & Wellness</p>
    `;

    await fetch("https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-key": cronKey,
      },
      body: JSON.stringify({
        to: recipient_email,
        subject,
        html,
      }),
    });

    // Re-send SignNow invite for each existing documentId (NO new docs created)
    const fromEmail = mustGetEnv("SIGNNOW_FROM_EMAIL");
    const roleName = mustGetEnv("SIGNNOW_WAIVER_ROLE_NAME");

    const message =
      `Hello${recipient_name ? ` ${recipient_name}` : ""},\n\n` +
      `Reminder: please sign your annual waiver for ${WAIVER_YEAR}.\n\n` +
      `— Happens By Chance Health & Wellness`;

    let resentCount = 0;

    for (const w of pending) {
      const docId = String((w as any).external_document_id ?? "").trim();
      if (!docId) continue;

      await signNowSendDocumentInvite({
        documentId: docId,
        fromEmail,
        toEmail: recipient_email,
        subject: `Happens By Chance — Annual Waiver (${WAIVER_YEAR})`,
        message,
        roleName,
        expirationDays: 30,
      });

      resentCount += 1;
    }

    return NextResponse.json({ ok: true, pending_count: pending.length, resent_count: resentCount });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
