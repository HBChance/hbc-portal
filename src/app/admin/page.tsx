import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import AdminMembersTable from "./AdminMembersTable";

const WAIVER_YEAR = 2026;

type MemberRow = {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  credits: number;
  purchase_count: number;
  last_purchase_at: string | null;
  waiver_status: "missing" | "sent" | "signed";
  waiver_sent_at: string | null;
  waiver_signed_at: string | null;
};

export default async function AdminHome() {
  const supabase = await createSupabaseServerClient();

  // 1) Require login
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) redirect("/login");

  // 2) Require admin (via members.is_admin)
  const { data: me, error: meErr } = await supabase
    .from("members")
    .select("id, is_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (meErr) {
    console.error("[admin] failed to read members row:", meErr.message);
    redirect("/app");
  }

  if (!me?.is_admin) redirect("/app");

  // 3) Fetch members list
  const { data: membersData, error: membersErr } = await supabase
    .from("members")
    .select("*")
    .order("created_at", { ascending: false });

  if (membersErr) console.error("[admin] members fetch error:", membersErr.message);
  // 3.5) Fetch purchase history (booking passes created from $45 purchases)
  const { data: purchasesData, error: pErr } = await supabase
    .from("booking_passes")
    .select("email_normalized, created_at");

  if (pErr) console.error("[admin] booking_passes fetch error:", pErr.message);

   const purchaseStatsByEmail = new Map<
    string,
    { count: number; last_purchase_at: string | null }
  >();


   (purchasesData ?? []).forEach((p: any) => {
    const emailKey = ((p.email_normalized ?? p.email ?? "") as string).toLowerCase().trim();
    if (!emailKey) return;

    const created = p.created_at as string | null;
    const prev = purchaseStatsByEmail.get(emailKey) ?? { count: 0, last_purchase_at: null };

    const nextCount = prev.count + 1;
    const nextLast =
      !prev.last_purchase_at || (created && created > prev.last_purchase_at)
        ? created ?? prev.last_purchase_at
        : prev.last_purchase_at;

    purchaseStatsByEmail.set(emailKey, { count: nextCount, last_purchase_at: nextLast });
  });

  // 4) Fetch balances view
  const { data: balancesData, error: balErr } = await supabase
    .from("v_member_credit_balance")
    .select("member_id,balance");

  if (balErr) console.error("[admin] balance fetch error:", balErr.message);

  const balanceById = new Map<string, number>();
  (balancesData ?? []).forEach((r: any) => {
    const n = typeof r.balance === "number" ? r.balance : Number(r.balance ?? 0);
    balanceById.set(r.member_id, Number.isFinite(n) ? n : 0);
  });
  // 4.5) Fetch guest profile names (Stripe checkout) for fallback display
  const { data: guestProfiles, error: gpErr } = await supabase
    .from("guest_profiles")
    .select("email_normalized, full_name");

  if (gpErr) console.error("[admin] guest_profiles fetch error:", gpErr.message);

  const guestNameByEmail = new Map<string, string>();
  (guestProfiles ?? []).forEach((g: any) => {
    const key = (g.email_normalized ?? "").toLowerCase().trim();
    const nm = (g.full_name ?? "").trim();
    if (key && nm) guestNameByEmail.set(key, nm);
  });

  // 5) Fetch waiver statuses (from waivers table)
  const { data: waiversData, error: waiverErr } = await supabase
    .from("waivers")
    .select("member_id, waiver_year, sent_at, signed_at")
    .eq("waiver_year", WAIVER_YEAR);

  if (waiverErr) console.error("[admin] waivers fetch error:", waiverErr.message);

  const waiverByMemberId = new Map<
    string,
    { sent_at: string | null; signed_at: string | null }
  >();

  (waiversData ?? []).forEach((w: any) => {
    waiverByMemberId.set(w.member_id, {
      sent_at: w.sent_at ?? null,
      signed_at: w.signed_at ?? null,
    });
  });

  const rows: MemberRow[] = (membersData ?? []).map((m: any) => {
    const first = (m.first_name ?? "").trim();
    const last = (m.last_name ?? "").trim();
        const normalizedEmail = (m.email ?? "").toLowerCase().trim();
    const fallbackGuestName = guestNameByEmail.get(normalizedEmail) ?? null;

    const name =
      [first, last].filter(Boolean).join(" ") ||
      fallbackGuestName ||
      null;

    const w = waiverByMemberId.get(m.id);
    const waiverSent = w?.sent_at ?? null;
    const waiverSigned = w?.signed_at ?? null;

    const waiver_status: MemberRow["waiver_status"] = waiverSigned
      ? "signed"
      : waiverSent
      ? "sent"
      : "missing";

    return {
      id: m.id,
      name,
      email: m.email,
      phone: m.phone ?? null,
      credits: balanceById.get(m.id) ?? 0,
      purchase_count: purchaseStatsByEmail.get((m.email ?? "").toLowerCase().trim())?.count ?? 0,
      last_purchase_at: purchaseStatsByEmail.get((m.email ?? "").toLowerCase().trim())?.last_purchase_at ?? null,
      waiver_status,
      waiver_sent_at: waiverSent,
      waiver_signed_at: waiverSigned,
    };
  });

  return (
    <main style={{ padding: 20, display: "grid", gap: 12 }}>
      <h1 style={{ margin: 0 }}>Admin Dashboard</h1>
      <div style={{ color: "#666" }}>
        Signed in as: <b>{user.email}</b> • Admin: <b>Yes</b>
      </div>

      <AdminMembersTable members={rows} />
    </main>
  );
}
