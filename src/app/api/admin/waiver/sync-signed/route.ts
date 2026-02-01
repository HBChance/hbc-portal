import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { signNowGetDocument } from "@/lib/signnow";

const WAIVER_YEAR = 2026;

function normalizeStatus(doc: any) {
  const raw =
    doc?.status ??
    doc?.document_status ??
    doc?.state ??
    doc?.data?.status ??
    doc?.data?.document_status ??
    doc?.data?.state ??
    null;

  return raw ? String(raw).toLowerCase() : "";
}

function getInvites(doc: any) {
  const invites = doc?.field_invites ?? doc?.data?.field_invites ?? null;
  return Array.isArray(invites) ? invites : [];
}

function getRoles(doc: any) {
  const roles = doc?.roles ?? doc?.data?.roles ?? null;
  return Array.isArray(roles) ? roles : [];
}

function inviteLooksSigned(inv: any): boolean {
  const status = String(inv?.status ?? inv?.state ?? "").toLowerCase();

  if (
    ["completed", "complete", "signed", "fulfilled", "done", "finished"].some((k) =>
      status.includes(k)
    )
  ) {
    return true;
  }

  if (inv?.signed_at || inv?.completed_at || inv?.finished_at) return true;
  if (inv?.signed === true || inv?.completed === true) return true;

  return false;
}

function roleLooksSigned(role: any): boolean {
  const pending = role?.pending;
  const declined = role?.declined;
  const status = String(role?.status ?? role?.state ?? "").toLowerCase();

  if (declined === true) return false;
  if (pending === false) return true;

  if (
    ["completed", "complete", "signed", "fulfilled", "done", "finished"].some((k) =>
      status.includes(k)
    )
  ) {
    return true;
  }

  if (role?.signed_at || role?.completed_at) return true;

  return false;
}

function isCompleted(doc: any): boolean {
  const s = normalizeStatus(doc);
  if (s && ["completed", "complete", "signed", "finished", "done"].some((k) => s.includes(k))) {
    return true;
  }

  const invites = getInvites(doc);
  if (invites.length > 0) {
    return invites.every(inviteLooksSigned);
  }

  const roles = getRoles(doc);
  if (roles.length > 0) {
    return roles.every(roleLooksSigned);
  }

  if (doc?.is_completed === true || doc?.completed === true) return true;

  return false;
}

/**
 * Converts a variety of SignNow-ish timestamps to an ISO string.
 * Handles:
 * - ISO strings
 * - Unix epoch seconds ("1769149758")
 * - Unix epoch milliseconds ("1769149758000")
 */
function toIsoTimestamp(value: any): string | null {
  if (value === null || value === undefined) return null;

  // numbers or numeric strings
  const s = String(value).trim();

  // If it's purely digits, treat as epoch
  if (/^\d+$/.test(s)) {
    // 10 digits = seconds, 13 digits = milliseconds (common)
    const n = Number(s);
    if (!Number.isFinite(n)) return null;

    if (s.length === 10) {
      return new Date(n * 1000).toISOString();
    }
    if (s.length === 13) {
      return new Date(n).toISOString();
    }

    // Some APIs return epoch seconds but not exactly 10 digits (rare) — best effort:
    // If it's in a "seconds-ish" range, assume seconds; otherwise ms.
    if (n < 50_000_000_000) {
      return new Date(n * 1000).toISOString();
    }
    return new Date(n).toISOString();
  }

  // Otherwise assume it's a date string parseable by Date
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();

  return null;
}

function extractSignedAt(doc: any): string | null {
  // Prefer field_invites timestamps
  const invites = getInvites(doc);
  const inviteTimes: string[] = [];
  for (const inv of invites) {
    const tRaw = inv?.signed_at || inv?.completed_at || inv?.finished_at || inv?.updated_at;
    const iso = toIsoTimestamp(tRaw);
    if (iso) inviteTimes.push(iso);
  }
  if (inviteTimes.length > 0) {
    return inviteTimes.sort().slice(-1)[0]; // latest
  }

  // Next try role timestamps
  const roles = getRoles(doc);
  const roleTimes: string[] = [];
  for (const r of roles) {
    const tRaw = r?.signed_at || r?.completed_at || r?.updated_at;
    const iso = toIsoTimestamp(tRaw);
    if (iso) roleTimes.push(iso);
  }
  if (roleTimes.length > 0) {
    return roleTimes.sort().slice(-1)[0];
  }

  // Fall back to doc timestamps
  const candidatesRaw = [
    doc?.signed_at,
    doc?.completed_at,
    doc?.updated,
    doc?.updated_at,
    doc?.data?.signed_at,
    doc?.data?.completed_at,
    doc?.data?.updated,
    doc?.data?.updated_at,
  ].filter(Boolean);

  for (const c of candidatesRaw) {
    const iso = toIsoTimestamp(c);
    if (iso) return iso;
  }

  return null;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify admin
  const { data: me } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const member_id = body?.member_id as string | undefined;
  if (!member_id) return NextResponse.json({ error: "member_id required" }, { status: 400 });

  // Load waiver row
  const { data: waiver, error: wErr } = await supabase
    .from("waivers")
    .select("id, waiver_year, status, external_document_id, signed_at")
    .eq("member_id", member_id)
    .eq("waiver_year", WAIVER_YEAR)
    .maybeSingle();

if (wErr) return NextResponse.json({ ok: false, error: wErr.message }, { status: 400 });

// Normal + expected states should NOT throw in the admin UI.
// Return 200 OK and mark as ignored (idempotent no-op).
if (!waiver) {
  return NextResponse.json(
    { ok: true, ignored: "no_waiver_row_for_member_year" },
    { status: 200 }
  );
}

if (!waiver.external_document_id) {
  return NextResponse.json(
    { ok: true, ignored: "no_external_document_id_to_sync" },
    { status: 200 }
  );
}

  // Fetch SignNow doc
  let doc: any;
  try {
    doc = await signNowGetDocument(waiver.external_document_id);
  } catch (e: any) {
    console.error("[waiver sync] signNowGetDocument failed", {
      member_id,
      waiver_id: waiver.id,
      external_document_id: waiver.external_document_id,
      message: e?.message,
    });
    return NextResponse.json({ error: e?.message || "signNow get document failed" }, { status: 400 });
  }

  const statusStr = normalizeStatus(doc);
  const completed = isCompleted(doc);
  const signedAt = extractSignedAt(doc);

  const invites = getInvites(doc);
  const roles = getRoles(doc);

  console.log("[waiver sync] SignNow doc fetched", {
    member_id,
    waiver_id: waiver.id,
    external_document_id: waiver.external_document_id,
    normalized_status: statusStr,
    completed,
    signedAtCandidate: signedAt ? signedAt : null,
    topLevelKeys: doc ? Object.keys(doc).slice(0, 40) : [],
    invitesCount: invites.length,
    invitesPreview: invites.slice(0, 5).map((inv: any) => ({
      email: inv?.email,
      role: inv?.role || inv?.role_name,
      status: inv?.status || inv?.state,
      signed: inv?.signed,
      signed_at: inv?.signed_at,
      completed_at: inv?.completed_at,
      finished_at: inv?.finished_at,
      updated_at: inv?.updated_at,
    })),
    rolesCount: roles.length,
    rolesPreview: roles.slice(0, 5).map((r: any) => ({
      name: r?.name,
      role_id: r?.role_id,
      status: r?.status || r?.state,
      pending: r?.pending,
      declined: r?.declined,
      signed_at: r?.signed_at,
      completed_at: r?.completed_at,
      updated_at: r?.updated_at,
    })),
  });

  if (!completed) {
    return NextResponse.json({
      ok: true,
      result: "not_completed",
      signnow_status: statusStr,
      signed_at_candidate: signedAt,
      invites_count: invites.length,
      roles_count: roles.length,
    });
  }

  // ✅ Idempotency: if already signed in DB, do nothing
  if (waiver.status === "signed" && waiver.signed_at) {
    return NextResponse.json({
      ok: true,
      result: "already_signed",
      signnow_status: statusStr,
      signed_at: waiver.signed_at,
    });
  }

  const finalSignedAt = signedAt || new Date().toISOString();

  const { error: upErr } = await supabase
    .from("waivers")
    .update({
      status: "signed",
      signed_at: finalSignedAt,
    })
    .eq("id", waiver.id);

  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

  console.log("[waiver sync] waiver updated to signed", {
    member_id,
    waiver_id: waiver.id,
    signed_at: finalSignedAt,
    signnow_status: statusStr,
  });

  return NextResponse.json({
    ok: true,
    result: "updated_to_signed",
    signnow_status: statusStr,
    signed_at: finalSignedAt,
  });
}
