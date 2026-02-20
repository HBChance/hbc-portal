import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { signNowGetDocument } from "@/lib/signnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAIVER_YEAR = new Date().getFullYear();

function looksCompleted(doc: any): boolean {
  // Normalize a few common shapes SignNow returns
  const status = String(
    doc?.status ??
      doc?.document_status ??
      doc?.state ??
      doc?.data?.status ??
      ""
  ).toLowerCase();

  if (
    status.includes("completed") ||
    status.includes("signed") ||
    status.includes("fulfilled") ||
    status === "complete"
  ) {
    return true;
  }

  // Some responses use boolean flags
  if (doc?.is_completed === true || doc?.completed === true) return true;
  if (doc?.data?.is_completed === true || doc?.data?.completed === true) return true;

  // Some responses expose signer/recipient statuses
  const signers =
    doc?.signers ??
    doc?.data?.signers ??
    doc?.recipients ??
    doc?.data?.recipients ??
    null;

  if (Array.isArray(signers) && signers.length > 0) {
    const allSigned = signers.every((s: any) => {
      const sStatus = String(s?.status ?? s?.signing_status ?? "").toLowerCase();
      return s?.signed === true || sStatus.includes("signed") || sStatus.includes("completed");
    });

    if (allSigned) return true;
  }

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