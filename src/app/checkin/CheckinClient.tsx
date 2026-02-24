"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

export default function CheckinClient() {
  const sp = useSearchParams();

  const token = useMemo(() => sp.get("token") || "", [sp]);

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string>("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMsg("");

    try {
      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || "Request failed");
      }

      setStatus("done");
      setMsg(json?.message || "Check-in processed.");
    } catch (err: any) {
      setStatus("error");
      setMsg(err?.message || "Something went wrong.");
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
      <h1>Check-in</h1>

      {!token ? (
        <p style={{ color: "#b45309" }}>
          Missing token in URL. Use a URL like: <code>/checkin?token=YOUR_TOKEN</code>
        </p>
      ) : (
        <p style={{ color: "#64748b", fontSize: 13 }}>
          Token detected.
        </p>
      )}

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          type="email"
          required
          placeholder="attendee@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, padding: 10 }}
        />
        <button type="submit" disabled={status === "loading" || !token} style={{ padding: "10px 14px" }}>
          {status === "loading" ? "Checking..." : "Check in"}
        </button>
      </form>

      {msg && (
        <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
          {msg}
        </p>
      )}
    </main>
  );
}