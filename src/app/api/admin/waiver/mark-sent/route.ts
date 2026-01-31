import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { signNowCopyTemplateToDocument, signNowSendDocumentInvite } from "@/lib/signnow";

const WAIVER_YEAR = 2026;

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

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

  // Check existing waiver row for this year
  const { data: existing } = await supabase
    .from("waivers")
    .select("status,sent_at,signed_at,external_document_id")
    .eq("recipient_email", recipient_email)
    .eq("waiver_year", WAIVER_YEAR)
    .maybeSingle();

  if (existing?.status === "signed") {
    return NextResponse.json({ error: "Waiver already signed for this year." }, { status: 409 });
  }
  if (existing?.status === "sent") {
    return NextResponse.json({ error: "Waiver already sent for this year." }, { status: 409 });
  }

  // Send signNow invite
  const templateId = mustGetEnv("SIGNNOW_WAIVER_TEMPLATE_ID");
  const fromEmail = mustGetEnv("SIGNNOW_FROM_EMAIL");
  const roleName = mustGetEnv("SIGNNOW_WAIVER_ROLE_NAME"); // "Participant"

  const subject = "Happens By Chance — Annual Waiver";
  const message =
    `Hello${recipient_name ? ` ${recipient_name}` : ""},\n\n` +
    `Please sign your annual waiver for ${WAIVER_YEAR}.\n\n` +
    `— Happens By Chance Health & Wellness`;

  let documentId: string;
  try {
    const copy = await signNowCopyTemplateToDocument({
      templateId,
      documentName: `HBC Waiver ${WAIVER_YEAR} — ${recipient_email}`,
    });
    documentId = copy.document_id;

    await signNowSendDocumentInvite({
      documentId,
      fromEmail,
      toEmail: recipient_email,
      subject,
      message,
      roleName,
      expirationDays: 30,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "signNow send failed" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();

  const { error: upsertErr } = await supabase
    .from("waivers")
    .upsert(
      {
        member_id,
        waiver_year: WAIVER_YEAR,
        status: "sent",
        recipient_email,
        recipient_name,
        external_provider: "signnow",
        external_document_id: documentId,
        sent_at: nowIso,
      },
      { onConflict: "recipient_email,waiver_year" }
    );

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, document_id: documentId });
}
