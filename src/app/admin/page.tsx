import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { RowActions } from "./RowActions";

export const dynamic = "force-dynamic";

type Overview = {
  stats: {
  member_count: number;
  total_credits: number;
purchases_count: number;

  members_with_zero: number;
  members_with_positive: number;
  triage: {
  credits_no_active_pass: number;
  pass_expired: number;
  waiver_missing: number;
  waiver_sent: number;
  no_recent_activity_30d: number;
  negative_balance: number;
};
};
  rows: Array<{
  member_id: string;
  email: string | null;
  full_name: string | null;
  member_created_at: string | null;

  balance: number;
  balance_updated_at?: string | null;

  purchases_count?: number;
  waiver_status?: "missing" | "sent" | "signed";

  last_activity_at: string | null;
  last_activity: null | {
    delta: number;
    reason: string | null;
    source_type: string | null;
    source_id: string | null;
  };

  last_pass: null | {
    created_at: string;
    expires_at: string | null;
    consumed_at: string | null;
    used_at?: string | null;
  };

  guests?: Array<{
    calendly_invitee_uri: string | null;
    invitee_email: string | null;
    invitee_name: string | null;
    event_start_at: string | null;
    waiver_status?: "missing" | "sent" | "signed";
    status: string;
  }>;
}>;
};

function fmt(s: string | null | undefined) {
  if (!s) return "—";

  return new Date(s).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Badge({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "green" | "red" | "amber" | "slate" | "blue";
}) {
  const style: React.CSSProperties =
    tone === "green"
      ? { background: "#dcfce7", color: "#166534" }
      : tone === "red"
      ? { background: "#fee2e2", color: "#991b1b" }
      : tone === "amber"
      ? { background: "#fef3c7", color: "#92400e" }
      : tone === "blue"
      ? { background: "#dbeafe", color: "#1e40af" }
      : { background: "#f1f5f9", color: "#0f172a" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        padding: "2px 8px",
        fontSize: 12,
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export default async function AdminHome() {
  // Auth: who is logged in
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) redirect("/login");

  // Admin gate (service role client)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: me, error: meErr } = await admin
    .from("members")
    .select("id, is_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (meErr) redirect("/app");
  if (!me?.is_admin) redirect("/app");

  // Pull overview (single payload)
  const res = await fetch(new URL("/api/admin/overview", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"), {
    cache: "no-store",
  });

  // If NEXT_PUBLIC_SITE_URL is not set in local/dev, the URL fallback works.
  // In production on Vercel, NEXT_PUBLIC_SITE_URL should be set.

  if (!res.ok) {
    const text = await res.text();
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>Admin Cockpit</h1>
        <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
      </div>
    );
  }

  const data = (await res.json()) as Overview;

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>Operator Cockpit</h1>
          <div style={{ color: "#666", marginTop: 4, fontSize: 13 }}>
            Signed in as <b>{user.email}</b>
          </div>
        </div>
        <div style={{ color: "#666", fontSize: 12 }}>Live</div>
      </div>

      {/* topline stats */}
      {/* topline stats + triage */}
<div
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10,
  }}
>
  {/* topline */}
  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Members</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.member_count}</div>
  </div>

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Total Credits</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.total_credits}</div>
  </div>

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Zero Balance</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.members_with_zero}</div>
  </div>

  {/* triage */}
  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Credits & no active pass</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.triage.credits_no_active_pass ?? 0}</div>
  </div>

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Pass expired</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.triage.pass_expired ?? 0}</div>
  </div>

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Waiver missing</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.triage.waiver_missing ?? 0}</div>
  </div>

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>Waiver sent</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.triage.waiver_sent ?? 0}</div>
  </div>

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
    <div style={{ fontSize: 12, color: "#64748b" }}>No activity (30d)</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{data.stats.triage.no_recent_activity_30d ?? 0}</div>
  </div>
</div>

      {/* scan table */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontWeight: 700 }}>Members</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{data.rows.length} rows</div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 1100, borderCollapse: "collapse", fontSize: 13 }}>
            <thead style={{ background: "#f8fafc", color: "#475569" }}>
              <tr>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Member</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Balance</th>
		<th style={{ textAlign: "left", padding: "10px 12px" }}>Purchases</th>
		<th style={{ textAlign: "left", padding: "10px 12px" }}>Waiver</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Last Activity</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Pass</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Member Since</th>
		<th style={{ textAlign: "left", padding: "10px 12px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const bal = Number(r.balance) || 0;
                const balTone = bal > 0 ? "green" : "red";

                const consumedAt = r.last_pass?.consumed_at ?? (r.last_pass as any)?.used_at ?? null;
                const expiresAt = r.last_pass?.expires_at ?? null;

                let passBadge = <Badge tone="slate">None</Badge>;
                if (r.last_pass) {
                  if (consumedAt) passBadge = <Badge tone="slate">Consumed</Badge>;
                  else if (expiresAt && Date.parse(expiresAt) < Date.now()) passBadge = <Badge tone="amber">Expired</Badge>;
                  else passBadge = <Badge tone="blue">Active</Badge>;
                }

                return (
                  <tr key={r.member_id} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ fontWeight: 700 }}>{r.full_name ?? "—"}</div>
                      <div style={{ fontSize: 12, color: "#64748b" }}>{r.email ?? r.member_id}</div>
{(() => {
  const guests = Array.isArray((r as any).guests) ? (r as any).guests : [];
  return (
  <details style={{ marginTop: 6 }}>
    <summary style={{ cursor: "pointer", fontSize: 12, color: "#64748b" }}>
      Guests ({(r as any).guests.length})
    </summary>

    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      {(r as any).guests.map((g: any) => (
        <div
          key={g.calendly_invitee_uri ?? `${g.invitee_email}-${g.event_start_at}`}
          style={{
            padding: 8,
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 12 }}>
            {g.invitee_name ?? "Guest"}
          </div>
          <div style={{ fontSize: 12, color: "#64748b" }}>
            {g.invitee_email ?? "—"}
          </div>
          <div style={{ fontSize: 12, color: "#64748b" }}>
            {fmt(g.event_start_at ?? null)}
          </div>
          <div style={{ marginTop: 6 }}>
            {g.waiver_status === "signed" ? (
              <Badge tone="green">Waiver Signed</Badge>
            ) : g.waiver_status === "sent" ? (
              <Badge tone="blue">Waiver Sent</Badge>
            ) : (
              <Badge tone="amber">Waiver Missing</Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  </details>
  );
})()}
                    </td>

                    <td style={{ padding: "10px 12px" }}>
                      <Badge tone={balTone}>{bal}</Badge>
                    </td>
		    <td style={{ padding: "10px 12px" }}>{(r as any).purchases_count ?? 0}</td>
<td style={{ padding: "10px 12px" }}>
  {(() => {
    const s = (r as any).waiver_status as "missing" | "sent" | "signed" | undefined;
    if (s === "signed") return <Badge tone="green">Signed</Badge>;
    if (s === "sent") return <Badge tone="blue">Sent</Badge>;
    return <Badge tone="amber">Missing</Badge>;
  })()}
</td>

                    <td style={{ padding: "10px 12px" }}>
                      <div>{fmt(r.last_activity_at)}</div>
                      <div style={{ fontSize: 12, color: "#64748b" }}>
                        {r.last_activity
                          ? `${r.last_activity.delta > 0 ? "+" : ""}${r.last_activity.delta} • ${
                              r.last_activity.reason ?? r.last_activity.source_type ?? "activity"
                            }`
                          : "—"}
                      </div>
                    </td>

                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{passBadge}</div>
                      <div style={{ fontSize: 12, color: "#64748b" }}>
                        {r.last_pass ? fmt(r.last_pass.created_at) : "—"}
                      </div>
                    </td>

                    <td style={{ padding: "10px 12px" }}>{fmt(r.member_created_at)}</td>
	
		<td style={{ padding: "10px 12px" }}>
		  <RowActions
  email={r.email}
  memberId={r.member_id}
  waiverStatus={(r as any).waiver_status}
  balance={Number(r.balance) || 0}
/>

		</td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
