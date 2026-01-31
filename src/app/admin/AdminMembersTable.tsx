"use client";

import React, { useEffect, useMemo, useState } from "react";

type MemberRow = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  phone?: string | null;
  credits: number;

  purchase_count?: number;
  last_purchase_at?: string | null;

  waiver_status: "missing" | "sent" | "signed";
  waiver_sent_at: string | null;
  waiver_signed_at: string | null;
};

type BookingIssueRow = {
  id: string;
  created_at: string;
  invitee_email: string;
  event_start_at: string | null;
  calendly_event_uri: string | null;
  error_code: string;
  handled_at: string | null;
  handled_status: string | null;
  handled_notes: string | null;
  phone: string | null;
};

function fmt(ts: string | null) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

async function postJson<T = any>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  if (!res.ok) {
    // Try to surface JSON error nicely if possible
    try {
      const j = JSON.parse(text);
      throw new Error(typeof j === "string" ? j : j?.error || JSON.stringify(j));
    } catch {
      throw new Error(text || `Request failed: ${res.status}`);
    }
  }

  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // In case endpoint returns plain text
    return {} as T;
  }
}

export default function AdminMembersTable({ members }: { members: MemberRow[] }) {
  const rows = useMemo(() => members ?? [], [members]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // =========================
  // Rejected Calendly bookings
  // =========================
  const [issues, setIssues] = useState<BookingIssueRow[]>([]);
  const [issuesLoaded, setIssuesLoaded] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const [timeRange, setTimeRange] = useState<"24h" | "30d" | "all">("30d");

  // Per-issue edit buffers (status/notes)
  const [issueEdits, setIssueEdits] = useState<Record<string, { status: string; notes: string }>>({});

      async function loadIssues(includeHandled: boolean, range: "24h" | "30d" | "all") {
    setIssuesLoaded(false);

    const qs = new URLSearchParams({
      limit: "100",
      range, // "24h" | "30d" | "all"
      show_handled: includeHandled ? "1" : "0",
    });

    const res = await fetch(`/api/admin/calendly/issues?${qs.toString()}`);
    const text = await res.text();

    if (!res.ok) {
      throw new Error(text || `Failed to load rejected bookings (${res.status})`);
    }

    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    // API returns { ok: true, issues: [...] }
    const rawIssues: any[] = Array.isArray(payload?.issues) ? payload.issues : [];

    // Normalize shape for the UI table (phone is nested under member embed)
    const normalized: BookingIssueRow[] = rawIssues.map((i: any) => ({
      ...i,
      handled_status: i.resolution ?? i.handled_status ?? null,
      handled_notes: i.notes ?? i.handled_notes ?? null,
      phone: i.member?.phone ?? i.phone ?? null,
    }));

    setIssues(normalized);

    // Initialize edit buffers from data
    const next: Record<string, { status: string; notes: string }> = {};
    for (const i of normalized) {
      next[i.id] = {
        status: i.handled_status ?? "contacted_customer",
        notes: i.handled_notes ?? "",
      };
    }
    setIssueEdits(next);

    setIssuesLoaded(true);
  }

  useEffect(() => {
        loadIssues(showHandled, timeRange).catch((e: any) => {
      console.error(e);
      setToast(e?.message || "Failed to load rejected bookings");
      setIssuesLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showHandled, timeRange]);

  async function action(key: string, fn: () => Promise<void>, successMessage?: string) {
    try {
      setBusyKey(key);
      setToast(null);
      await fn();
      setToast(successMessage ?? "Saved.");
    } catch (e: any) {
      console.error(e);
      setToast(e?.message || "Action failed");
    } finally {
      setBusyKey(null);
    }
  }

  function displayName(m: MemberRow) {
    const viaParts = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
    if (viaParts) return viaParts;
    if (m.name) return m.name;
    return "";
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setToast("Copied");
    setTimeout(() => setToast(null), 1200);
  }

  return (
  <>
    <section style={{ display: "grid", gap: 12 }}>
      {toast ? (
        <div
          style={{
            padding: "8px 10px",
            border: "1px solid #ddd",
            borderRadius: 8,
            background: "#fafafa",
            color: "#333",
            fontSize: 14,
          }}
        >
          {toast}
        </div>
      ) : null}

      {/* =========================
          Rejected bookings section
         ========================= */}
      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, background: "white" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700 }}>Rejected bookings</div>
            <div style={{ fontSize: 13, color: "#555", marginTop: 4 }}>
              These are Calendly bookings your system rejected (ex: INSUFFICIENT_CREDITS). Resolve them here and they’ll be
              archived (still permanently logged).
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#333" }}>
              <input type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />
              Show handled (history)
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#333" }}>
              Range
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as any)}
                style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd", background: "white" }}
              >
                <option value="24h">Last 24 hours</option>
                <option value="30d">Last 30 days</option>
                <option value="all">All time</option>
              </select>
            </label>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          {!issuesLoaded ? (
            <div style={{ fontSize: 13, color: "#555" }}>Loading…</div>
          ) : issues.length === 0 ? (
            <div style={{ fontSize: 13, color: "#555" }}>No rejected bookings found.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["When", "Email", "Phone", "Start", "Error", "Event URI", "Status", "Notes", "Actions"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "10px 8px",
                          borderBottom: "1px solid #eee",
                          fontSize: 13,
                          color: "#555",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {issues.map((i) => {
                    const edit = issueEdits[i.id] ?? { status: "contacted_customer", notes: "" };

                    return (
                      <tr key={i.id}>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                          {fmt(i.created_at)}
                          {i.handled_at ? (
                            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                              handled: {fmt(i.handled_at)}
                            </div>
                          ) : null}
                        </td>

                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{i.invitee_email}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{i.phone ?? ""}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                          {i.event_start_at ? new Date(i.event_start_at).toLocaleString() : ""}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{i.error_code}</td>

                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>
                          {i.calendly_event_uri ? (
                            <a href={i.calendly_event_uri} target="_blank" rel="noreferrer">
                              link
                            </a>
                          ) : (
                            ""
                          )}
                        </td>

                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>
                          <select
                            value={edit.status}
                            onChange={(e) =>
                              setIssueEdits((prev) => ({
                                ...prev,
                                [i.id]: { ...edit, status: e.target.value },
                              }))
                            }
                            style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd" }}
                          >
                            <option value="contacted_customer">contacted customer</option>
                            <option value="sent_pay_link">sent pay link</option>
                            <option value="canceled">canceled</option>
                            <option value="resolved_other">resolved other</option>
                          </select>
                        </td>

                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee", minWidth: 240 }}>
                          <input
                            value={edit.notes}
                            onChange={(e) =>
                              setIssueEdits((prev) => ({
                                ...prev,
                                [i.id]: { ...edit, notes: e.target.value },
                              }))
                            }
                            placeholder="Notes…"
                            style={{
                              width: "100%",
                              padding: "6px 8px",
                              borderRadius: 8,
                              border: "1px solid #ddd",
                            }}
                          />
                        </td>

                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                         <button
  type="button"
  disabled={busyKey === `handle:${i.id}`}
  onClick={() =>
    action(
      `handle:${i.id}`,
      async () => {
        await postJson("/api/admin/calendly/issues/mark-handled", {
          issue_id: i.id,
          handled_status: edit.status,
          handled_notes: edit.notes,
        });

        // refresh issues list without full page reload
        await loadIssues(showHandled, timeRange);
      },
      "Issue updated."
    )
  }
  style={{
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid #ddd",
    background: "white",
    cursor: "pointer",
  }}
>
  Save / Archive
</button>

                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* =========================
          Members table
         ========================= */}
           <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: "white", border: "1px solid #ddd" }}>
                   <thead>
            <tr>
              {[
                "Name",
                "Email",
                "Phone",
                "Credits",
                "Purchases",
                "Last purchase",
                "Waiver",
                "Sent",
                "Signed",
                "Member ID",
                "Actions",
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "10px 8px",
                    borderBottom: "1px solid #ddd",
                    fontSize: 13,
                    color: "#555",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((m) => {
              const shortId = `${m.id.slice(0, 8)}…${m.id.slice(-6)}`;
              const fullName = displayName(m);

              return (
                <tr key={m.id}>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{fullName}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{m.email}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{m.phone ?? ""}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{m.credits}</td>
		  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{m.purchase_count ?? 0}</td>
		  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{fmt(m.last_purchase_at)}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{m.waiver_status}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{fmt(m.waiver_sent_at)}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>{fmt(m.waiver_signed_at)}</td>

                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <code style={{ fontSize: 12 }}>{shortId}</code>
                      <button
                        type="button"
                        onClick={() => copy(m.id)}
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        Copy
                      </button>
                    </div>
                  </td>

                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #eee" }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {/* Waiver actions */}
                      <button
                        type="button"
                        disabled={busyKey === `sent:${m.id}`}
                        onClick={() =>
                          action(`sent:${m.id}`, async () => {
                            await postJson("/api/admin/waiver/mark-sent", {
                              member_id: m.id,
                              recipient_email: m.email,
                              recipient_name: fullName || null,
                            });
                            window.location.reload();
                          })
                        }
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        Mark sent
                      </button>

                      <button
                        type="button"
                        disabled={busyKey === `signed:${m.id}`}
                        onClick={() =>
                          action(`signed:${m.id}`, async () => {
                            await postJson("/api/admin/waiver/mark-signed", {
                              member_id: m.id,
                              recipient_email: m.email,
                              recipient_name: fullName || null,
                            });
                            window.location.reload();
                          })
                        }
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        Mark signed
                      </button>

                      <button
                        type="button"
                        disabled={busyKey === `sync:${m.id}`}
                        onClick={() =>
                          action(
                            `sync:${m.id}`,
                            async () => {
                              await postJson("/api/admin/waiver/sync-signed", { member_id: m.id });
                              window.location.reload();
                            },
                            "Synced."
                          )
                        }
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        Sync signed
                      </button>

                      {/* Credits */}
                      <button
                        type="button"
                        disabled={busyKey === `add1:${m.id}`}
                        onClick={() =>
                          action(`add1:${m.id}`, async () => {
                            await postJson("/api/admin/credits/add", {
                              member_id: m.id,
                              amount: 1,
                              reason: "Manual grant (+1)",
                            });
                            window.location.reload();
                          })
                        }
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        +1
                      </button>

                      <button
                        type="button"
                        disabled={busyKey === `add4:${m.id}`}
                        onClick={() =>
                          action(`add4:${m.id}`, async () => {
                            await postJson("/api/admin/credits/add", {
                              member_id: m.id,
                              amount: 4,
                              reason: "Manual grant (+4)",
                            });
                            window.location.reload();
                          })
                        }
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        +4
                      </button>

                      <button
                        type="button"
                        disabled={busyKey === `redeem:${m.id}`}
                        onClick={() =>
                          action(`redeem:${m.id}`, async () => {
                            await postJson("/api/admin/credits/redeem", {
                              member_id: m.id,
                              reason: "Manual redemption (-1)",
                            });
                            window.location.reload();
                          })
                        }
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: "1px solid #ddd",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        -1
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  </>
  );
}
