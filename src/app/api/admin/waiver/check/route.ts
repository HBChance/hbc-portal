import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { signNowGetDocument } from "@/lib/signnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAIVER_YEAR = new Date().getFullYear();

function looksCompleted(doc: any) {
  // SignNow responses vary; this covers common shapes.
  const status = String(doc?.status ?? doc?.document_status ?? doc?.state ?? "").toLowerCase();
  const completed =
    status.includes("completed") ||
    status.includes("signed") ||
    status.includes("fulfilled") ||
    doc?.is_completed === true ||
    doc?.completed === true;

  return completed;
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

    // Optional: member_id for targeted check
    const body = await req.json().catch(() => ({}));
    const member_id = body?.member_id ? String(body.member_id) : null;

    // Load unsigned waivers (this year) that have a SignNow document id
    let q = supabase
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
          const { error: upErr } = await supabase
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