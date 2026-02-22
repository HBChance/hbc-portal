import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { signNowCopyTemplateToDocument, signNowSendDocumentInvite } from "@/lib/signnow";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

const WAIVER_YEAR = 2026;

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const member_id = body?.member_id as string | undefined;
  if (!member_id) return NextResponse.json({ error: "member_id required" }, { status: 400 });

  // Load member
  const { data: member, error: memErr } = await supabase
    .from("members")
    .select("id,email,first_name,last_name")
    .eq("id", member_id)
    .single();

  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 400 });
  if (!member?.email) return NextResponse.json({ error: "Member has no email" }, { status: 400 });

  const recipient_email = member.email as string;
  const recipient_name =
    [member.first_name, member.last_name].filter(Boolean).join(" ").trim() || null;

  // Load all waiver rows for this member+year that still need a doc_id
  const { data: pending, error: pendErr } = await admin
    .from("waivers")
    .select("id, attendee_name, status, external_document_id, calendly_invitee_uri")
    .eq("member_id", member_id)
    .eq("waiver_year", WAIVER_YEAR);

  if (pendErr) return NextResponse.json({ error: pendErr.message }, { status: 400 });

  const needsSend = (pending ?? []).filter((w: any) => {
    const st = String(w.status ?? "").toLowerCase();
    const hasDoc = String(w.external_document_id ?? "").trim().length > 0;
    return st !== "signed" && !hasDoc;
  });

  if (needsSend.length === 0) {
    return NextResponse.json({ error: "No waivers need to be sent." }, { status: 409 });
  }

  // Send signNow invite(s) for each missing doc
  const templateId = mustGetEnv("SIGNNOW_WAIVER_TEMPLATE_ID");
  const fromEmail = mustGetEnv("SIGNNOW_FROM_EMAIL");
  const roleName = mustGetEnv("SIGNNOW_WAIVER_ROLE_NAME") || "Participant";

  let sentCount = 0;
  const errors: Array<{ waiver_id: string; error: string }> = [];

  for (const w of needsSend) {
    try {
      const who = String((w as any).attendee_name ?? "").trim() || (recipient_name ?? "Participant");

      const subject = `Happens By Chance — Annual Waiver (${WAIVER_YEAR})`;
      const message =
        `Hello${recipient_name ? ` ${recipient_name}` : ""},\n\n` +
        `Please sign the annual waiver for ${WAIVER_YEAR}.\n` +
        `Participant: ${who}\n\n` +
        `— Happens By Chance Health & Wellness`;

      const copy = await signNowCopyTemplateToDocument({
        templateId,
        documentName: `HBC Waiver ${WAIVER_YEAR} — ${recipient_email} — ${who}`,
      });

      const documentId = copy.document_id;

      await signNowSendDocumentInvite({
        documentId,
        fromEmail,
        toEmail: recipient_email, // <-- per your preference: member receives all waivers
        subject,
        message,
        roleName,
        expirationDays: 30,
      });

      const nowIso = new Date().toISOString();

      const { error: upErr } = await admin
        .from("waivers")
        .update({
          status: "sent",
          external_provider: "signnow",
          external_document_id: documentId,
          sent_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", w.id);

      if (upErr) {
        errors.push({ waiver_id: w.id, error: upErr.message });
      } else {
        sentCount += 1;
      }
    } catch (e: any) {
      errors.push({ waiver_id: w.id, error: e?.message ?? "send failed" });
    }
  }

  if (sentCount === 0) {
    return NextResponse.json({ error: "Failed to send any waivers.", details: errors }, { status: 400 });
  }

  return NextResponse.json({ ok: true, sent_count: sentCount, errors });
}
