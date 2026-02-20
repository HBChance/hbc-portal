import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { signNowGetDocument } from "@/lib/signnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAIVER_YEAR = new Date().getFullYear();

function looksCompleted(doc: any): boolean {
  // 1) Direct status flags
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
    status.includes("fulfilled")
  ) {
    return true;
  }

  // 2) Field invites (most common in your SignNow flow)
  const invites =
    doc?.field_invites ??
    doc?.data?.field_invites ??
    doc?.fieldInvites ??
    null;

  if (Array.isArray(invites) && invites.length > 0) {
    const allDone = invites.every((i: any) => {
      const s = String(i?.status ?? i?.state ?? "").toLowerCase();
      return (
        s.includes("fulfilled") ||
        s.includes("completed") ||
        s.includes("signed")
      );
    });

    if (allDone) return true;
  }

  // 3) Signature objects (alternate shape)
  const sigs = doc?.signatures ?? doc?.data?.signatures ?? null;

  if (Array.isArray(sigs) && sigs.length > 0) {
    const allSigned = sigs.every((s: any) => {
      const st = String(s?.status ?? "").toLowerCase();
      return (
        st.includes("signed") ||
        st.includes("completed") ||
        st.includes("fulfilled")
      );
    });

    if (allSigned) return true;
  }

  // 4) Boolean completion flags
  if (
    doc?.is_completed === true ||
    doc?.completed === true ||
    doc?.data?.is_completed === true ||
    doc?.data?.completed === true
  ) {
    return true;
  }

  return false;
}

  // 2) Boolean flags
  if (doc?.is_completed === true || doc?.completed === true) {
    return true;
  }

  // 3) Invite arrays (SignNow commonly uses these)
  const invites = (doc?.field_invites ?? doc?.invites ?? doc?.signing_invites ?? []) as any[];

  if (Array.isArray(invites) && invites.length > 0) {
    const allDone = invites.every((i) => {
      const s = String(i?.status ?? i?.state ?? "").toLowerCase();
      return (
        s.includes("fulfilled") ||
        s.includes("signed") ||
        s.includes("completed") ||
        s === "complete"
      );
    });

    if (allDone) return true;
  }

  // 4) Role-based fallback
  const roles = (doc?.roles ?? doc?.signers ?? []) as any[];

  if (Array.isArray(roles) && roles.length > 0) {
    const allRoleDone = roles.every((r) => {
      const rs = String(r?.status ?? r?.state ?? "").toLowerCase();
      return (
        rs.includes("fulfilled") ||
        rs.includes("signed") ||
        rs.includes("completed") ||
        r?.is_completed === true
      );
    });

    if (allRoleDone) return true;
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

    for (const w of waivers) {
      const docId = String(w.external_document_id ?? "").trim();
      if (!docId) continue;

      checked += 1;

      try {
        const doc = await signNowGetDocument(docId);
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
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}