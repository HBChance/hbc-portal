"use client";

import { useState } from "react";

export default function UnlockMembershipPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string>("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMsg("");

    try {
      const res = await fetch("/api/unlock-membership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || "Request failed");
      }

      // We intentionally keep UI simple and avoid revealing eligibility on-screen.
      setStatus("done");
      setMsg("Check your email for next steps. If you don’t see it soon, check spam/junk.");
    } catch (err: any) {
      setStatus("error");
      setMsg(err?.message || "Something went wrong.");
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
      <h1>Unlock Membership</h1>
      <p>
        Enter the <strong>member’s email</strong> (the email that attended the session).
      </p>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          type="email"
          required
          placeholder="member@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, padding: 10 }}
        />
        <button
          type="submit"
          disabled={status === "loading"}
          style={{ padding: "10px 14px" }}
        >
          {status === "loading" ? "Sending..." : "Send"}
        </button>
      </form>

      {msg && (
        <p style={{ marginTop: 12 }}>
          {msg}{" "}
          <br />
          If you believe this is an error, email{" "}
          <a href="mailto:membership@happensbychance.com">membership@happensbychance.com</a>.
        </p>
      )}
    </main>
  );
}