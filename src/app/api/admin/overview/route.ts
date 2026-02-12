import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}
function isExpired(expiresAt: string | null) {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) < Date.now();
}

function hoursUntil(ts: string | null) {
  if (!ts) return null;
  const ms = Date.parse(ts) - Date.now();
  return ms / (1000 * 60 * 60);
}


export async function GET() {
  const supabase = supabaseAdmin();

  // 1) Balances (security invoker view)
  const { data: balances, error: balErr } = await supabase
    .from("v_member_credit_balance")
    .select("member_id,balance");

  if (balErr) {
    return NextResponse.json({ error: balErr.message }, { status: 500 });
  }

  const memberIds = (balances ?? []).map((b: any) => b.member_id);

  // 2) Member identity
  const { data: members, error: memErr } = await supabase
    .from("members")
    .select("id,email,first_name,last_name,phone,created_at")
    .in("id", memberIds);

  if (memErr) {
    return NextResponse.json({ error: memErr.message }, { status: 500 });
  }

  // 3) Latest ledger entry per member (for “last activity”)
  const { data: ledgerRows, error: ledErr } = await supabase
    .from("credits_ledger")
    .select("member_id,entry_type,quantity,reason,created_at")
    .in("member_id", memberIds)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (ledErr) {
    return NextResponse.json({ error: ledErr.message }, { status: 500 });
  }

  const latestLedgerByMember = new Map<string, any>();
  for (const row of ledgerRows ?? []) {
    if (!latestLedgerByMember.has(row.member_id)) latestLedgerByMember.set(row.member_id, row);
  }
// 3.5) Stripe purchase counts (count grant rows whose reason starts with "stripe")
const { data: purchaseGrants, error: pgErr } = await supabase
  .from("credits_ledger")
  .select("member_id,entry_type,reason")
  .eq("entry_type", "grant")
  .ilike("reason", "stripe%");

if (pgErr) {
  return NextResponse.json({ error: pgErr.message }, { status: 500 });
}

const purchasesCountByMember = new Map<string, number>();
for (const r of purchaseGrants ?? []) {
  const k = r.member_id as string;
  purchasesCountByMember.set(k, (purchasesCountByMember.get(k) ?? 0) + 1);
}
// 3.75) Waiver status (current year)
const WAIVER_YEAR = new Date().getFullYear();

const { data: waivers, error: wErr } = await supabase
  .from("waivers")
  .select("member_id,recipient_email,status,sent_at,signed_at,waiver_year")
  .eq("waiver_year", WAIVER_YEAR);

if (wErr) {
  return NextResponse.json({ error: wErr.message }, { status: 500 });
}

const waiverByMemberId = new Map<string, any>();
const waiverByEmail = new Map<string, any>();

for (const w of waivers ?? []) {
  if (w.member_id) waiverByMemberId.set(w.member_id, w);
  if (w.recipient_email) waiverByEmail.set(String(w.recipient_email).toLowerCase(), w);
}

  // 4) Latest booking pass per member
  const { data: passes, error: passErr } = await supabase
    .from("booking_passes")
    .select("member_id,created_at,expires_at,used_at")
    .in("member_id", memberIds)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (passErr) {
    return NextResponse.json({ error: passErr.message }, { status: 500 });
  }

  const latestPassByMember = new Map<string, any>();
  for (const p of passes ?? []) {
    if (!latestPassByMember.has(p.member_id)) latestPassByMember.set(p.member_id, p);
  }

  const membersById = new Map((members ?? []).map((m: any) => [m.id, m]));
// 4.5) Stripe purchase counts (count grant rows whose reason starts with "stripe")

  const rows = (balances ?? [])
    .map((b: any) => {
      const m = membersById.get(b.member_id);
      const lastLedger = latestLedgerByMember.get(b.member_id) ?? null;
      const lastPass = latestPassByMember.get(b.member_id) ?? null;
let pass_state: "none" | "active" | "expired" | "consumed" = "none";
let pass_expires_in_hours: number | null = null;

if (lastPass) {
  if (lastPass.used_at) pass_state = "consumed";
  else if (isExpired(lastPass.expires_at ?? null)) pass_state = "expired";
  else pass_state = "active";

  pass_expires_in_hours = hoursUntil(lastPass.expires_at ?? null);
}

const balance = Number(b.balance ?? 0);

// ----- Waiver status (compute FIRST so flags can use it)
const waiverStatus: "missing" | "sent" | "signed" = (() => {
  const w =
    waiverByMemberId.get(b.member_id) ??
    (m?.email ? waiverByEmail.get(String(m.email).toLowerCase()) : null);

  if (!w) return "missing";
  if (w.status === "signed") return "signed";
  if (w.status === "sent") return "sent";
  return "missing";
})();

// ----- Flags (now safe to reference waiverStatus)
const flags = {
  // Safety: should never happen, but measurable
  negative_balance: balance < 0,

  // Member has credits but no active booking link
  credits_no_active_pass: balance > 0 && pass_state !== "active",

  // Booking pass expired
  pass_expired: pass_state === "expired",

  // Waiver state
  waiver_missing: waiverStatus === "missing",
  waiver_sent: waiverStatus === "sent",

  // No activity in 30 days
  no_recent_activity_30d:
    !lastLedger?.created_at ||
    Date.parse(lastLedger.created_at) <
      Date.now() - 30 * 24 * 60 * 60 * 1000,
};

      const fullName = m
        ? `${(m.first_name ?? "").trim()} ${(m.last_name ?? "").trim()}`.trim() || null
        : null;

      return {
        member_id: b.member_id,
        email: m?.email ?? null,
        full_name: fullName,
        phone: m?.phone ?? null,
        member_created_at: m?.created_at ?? null,
        balance,
	purchases_count: purchasesCountByMember.get(b.member_id) ?? 0,
	waiver_status: waiverStatus,
        last_activity_at: lastLedger?.created_at ?? null,
        last_activity: lastLedger
          ? {
              entry_type: lastLedger.entry_type,
              quantity: lastLedger.quantity,
              reason: lastLedger.reason ?? null,
            }
          : null,
	pass_state,
	pass_expires_in_hours,
	flags,

        last_pass: lastPass
          ? {
              created_at: lastPass.created_at,
              expires_at: lastPass.expires_at ?? null,
              used_at: lastPass.used_at ?? null,
            }
          : null,
      };
    })
    .sort((a: any, b: any) => {
      const at = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
      const bt = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
      if (bt !== at) return bt - at;
      const ac = a.member_created_at ? Date.parse(a.member_created_at) : 0;
      const bc = b.member_created_at ? Date.parse(b.member_created_at) : 0;
      return bc - ac;
    });

 const stats = {
  member_count: rows.length,
  total_credits: rows.reduce((sum: number, r: any) => sum + (Number(r.balance) || 0), 0),
  members_with_zero: rows.filter((r: any) => (Number(r.balance) || 0) === 0).length,
  members_with_positive: rows.filter((r: any) => (Number(r.balance) || 0) > 0).length,
  triage: {
  credits_no_active_pass: rows.filter((r: any) => r.flags.credits_no_active_pass).length,
  pass_expired: rows.filter((r: any) => r.flags.pass_expired).length,
  waiver_missing: rows.filter((r: any) => r.flags.waiver_missing).length,
  waiver_sent: rows.filter((r: any) => r.flags.waiver_sent).length,
  no_recent_activity_30d: rows.filter((r: any) => r.flags.no_recent_activity_30d).length,
  negative_balance: rows.filter((r: any) => r.flags.negative_balance).length,
},


};

  return NextResponse.json({ stats, rows });
}
