"use client";

import { useState } from "react";

export function RowActions({
  email,
  memberId,
}: {
  email: string | null;
  memberId: string;
}) {
  const [busy, setBusy] = useState<null | "booking" | "waiver">(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function postJson(url: string, body: any) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={!email || busy !== null}
        onClick={async () => {
          if (!email) return;
          setMsg(null);
          setBusy("booking");
          try {
            await postJson("/api/admin/booking-pass/send", { email });
            setMsg("Booking link sent");
            window.location.reload();
          } catch (e: any) {
            setMsg(e?.message || "Failed");
          } finally {
            setBusy(null);
          }
        }}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          padding: "6px 10px",
          fontSize: 12,
          background: "white",
          opacity: !email || busy !== null ? 0.5 : 1,
          cursor: !email || busy !== null ? "not-allowed" : "pointer",
        }}
        title={!email ? "Missing email" : "Send booking link email"}
      >
        {busy === "booking" ? "Sending…" : "Send booking link"}
      </button>

      <button
        type="button"
        disabled={busy !== null}
        onClick={async () => {
          setMsg(null);
          setBusy("waiver");
          try {
            await postJson("/api/admin/waiver/mark-sent", { member_id: memberId });
            setMsg("Waiver sent");
            window.location.reload();
          } catch (e: any) {
            setMsg(e?.message || "Failed");
          } finally {
            setBusy(null);
          }
        }}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          padding: "6px 10px",
          fontSize: 12,
          background: "white",
          opacity: busy !== null ? 0.5 : 1,
          cursor: busy !== null ? "not-allowed" : "pointer",
        }}
        title="Send annual waiver via SignNow"
      >
        {busy === "waiver" ? "Sending…" : "Send waiver"}
      </button>

      {msg ? <span style={{ fontSize: 12, color: "#64748b" }}>{msg}</span> : null}
    </div>
  );
}
