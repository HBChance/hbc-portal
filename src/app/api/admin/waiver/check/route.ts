import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { signNowGetDocument } from "@/lib/signnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAIVER_YEAR = new Date().getFullYear();
function summarizeSignNowDoc(doc: any) {
  const topStatus = doc?.status ?? doc?.document_status ?? doc?.state ?? null;
  const dataStatus = doc?.data?.status ?? doc?.data?.document_status ?? doc?.data?.state ?? null;

  const invites = doc?.invites ?? doc?.data?.invites ?? null;
  const signers = doc?.signers ?? doc?.data?.signers ?? null;
  const recipients = doc?.recipients ?? doc?.data?.recipients ?? null;

  const pickStatuses = (arr: any) =>
    Array.isArray(arr)
      ? arr.slice(0, 5).map((x: any) => ({
          status: x?.status ?? x?.signing_status ?? x?.state ?? null,
          signed: x?.signed ?? null,
          // DO NOT log emails/names
        }))
      : null;

  return {
    keys: doc ? Object.keys(doc).slice(0, 30) : [],
    status: topStatus,
    data_status: dataStatus,
    has_invites: Array.isArray(invites) ? invites.length : null,
    invite_statuses: pickStatuses(invites),
    has_signers: Array.isArray(signers) ? signers.length : null,
    signer_statuses: pickStatuses(signers),
    has_recipients: Array.isArray(recipients) ? recipients.length : null,
    recipient_statuses: pickStatuses(recipients),
  };
}
function looksCompleted(doc: any): boolean {
  const status = String(
    doc?.status ??
      doc?.document_status ??
      doc?.state ??
      doc?.data?.status ??
      doc?.data?.document_status ??
      doc?.data?.state ??
      ""
  ).toLowerCase();

  // 1) Obvious status words
  if (
    status.includes("completed") ||
    status.includes("complete") ||
    status.includes("signed") ||
    status.includes("fulfilled") ||
    status.includes("done")
  ) {
    return true;
  }

  // 2) Boolean flags
  if (doc?.is_completed === true || doc?.completed === true) return true;
  if (doc?.data?.is_completed === true || doc?.data?.completed === true) return true;

  // Helper: does an array of participants look fully signed?
  const allSignedLike = (arr: any) => {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    return arr.every((x: any) => {
      const s = String(x?.status ?? x?.signing_status ?? x?.state ?? "").toLowerCase();
      return (
        x?.signed === true ||
        s.includes("signed") ||
        s.includes("completed") ||
        s.includes("complete") ||
        s.includes("fulfilled")
      );
    });
  };

  // 3) Signers / recipients
  const signers = doc?.signers ?? doc?.data?.signers ?? null;
  const recipients = doc?.recipients ?? doc?.data?.recipients ?? null;
  if (allSignedLike(signers) || allSignedLike(recipients)) return true;

  // 4) Invites (very common in SignNow)
  const invites = doc?.invites ?? doc?.data?.invites ?? null;
  if (allSignedLike(invites)) return true;

  return false;
}
export async function POST(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const admin = createSupabaseAdminClient();

    // Auth
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: me } = await supabaseAuth
      .from("members")
      .select("is_admin")
      .eq("user_id", user.id)
      .single();

    if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Optional: member_id for targeted check
    const body = await req.json().catch(() => ({}));
    const member_id = body?.member_id ? String(body.member_id) : null;

    // Load unsigned waivers (this year) that have a SignNow document id
    let q = admin
      .from("waivers")
      .select("id, member_id, status, external_document_id")
      .eq("waiver_year", WAIVER_YEAR)
      .not("external_document_id", "is", null);

    if (member_id) q = q.eq("member_id", member_id);

    const { data: rows, error: wErr } = await q;
    if (wErr) return NextResponse.json({ error: wErr.message }, { status: 400 });

    const waivers = (rows ?? []).filter((w: any) => String(w.status ?? "").toLowerCase() !== "signed");

    let checked = 0;
    let marked_signed = 0;
    const errors: Array<{ waiver_id: string; error: string }> = [];
const debug_docs: any[] = [];
    for (const w of waivers) {
      const docId = String(w.external_document_id ?? "").trim();
      if (!docId) continue;

      checked += 1;

      try {
        const doc = await signNowGetDocument(docId);
console.log("[waiver-check] signnow doc summary", { waiver_id: w.id, docId, summary: summarizeSignNowDoc(doc) });
if (debug_docs.length < 3) {
  const pick = (v: any) => (v == null ? v : String(v));
  const first = (arr: any) => (Array.isArray(arr) && arr.length ? arr[0] : null);

  debug_docs.push({
    waiver_id: w.id,
    docId,
    top_keys: Object.keys(doc ?? {}).slice(0, 40),

    // common top-level status fields
    status: pick((doc as any)?.status),
    document_status: pick((doc as any)?.document_status),
    state: pick((doc as any)?.state),
    is_completed: (doc as any)?.is_completed ?? null,
    completed: (doc as any)?.completed ?? null,

    // common nested shapes
    data_keys: Object.keys((doc as any)?.data ?? {}).slice(0, 40),
    data_status: pick((doc as any)?.data?.status),
    data_document_status: pick((doc as any)?.data?.document_status),
    data_state: pick((doc as any)?.data?.state),
    data_is_completed: (doc as any)?.data?.is_completed ?? null,
    data_completed: (doc as any)?.data?.completed ?? null,

    // signer/recipient arrays (top-level or nested)
    signers_len: Array.isArray((doc as any)?.signers) ? (doc as any).signers.length : null,
    recipients_len: Array.isArray((doc as any)?.recipients) ? (doc as any).recipients.length : null,
    data_signers_len: Array.isArray((doc as any)?.data?.signers) ? (doc as any).data.signers.length : null,
    data_recipients_len: Array.isArray((doc as any)?.data?.recipients) ? (doc as any).data.recipients.length : null,

    first_signer: first((doc as any)?.signers),
    first_recipient: first((doc as any)?.recipients),
    first_data_signer: first((doc as any)?.data?.signers),
    first_data_recipient: first((doc as any)?.data?.recipients),
  });
}
console.log("[waiver-check] doc snapshot", {
  docId,
  topKeys: Object.keys(doc ?? {}),
  status: doc?.status ?? null,
  document_status: doc?.document_status ?? null,
  state: doc?.state ?? null,
  field_invites: doc?.field_invites ?? null,
  signers: doc?.signers ?? null,
});
        if (looksCompleted(doc)) {
          const { error: upErr } = await admin
            .from("waivers")
            .update({
              status: "signed",
              signed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", w.id);

          if (!upErr) marked_signed += 1;
          else errors.push({ waiver_id: w.id, error: upErr.message });
        }
      } catch (e: any) {
        errors.push({ waiver_id: w.id, error: e?.message ?? "SignNow check failed" });
      }
    }

    return NextResponse.json({
      ok: true,
      member_id,
      total_candidates: waivers.length,
      checked,
      marked_signed,
      errors,
      debug_docs,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}