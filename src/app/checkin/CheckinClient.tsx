"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

type ApiResp =
  | { ok: true; approved: true; status?: string; message?: string }
  | { ok: true; approved: false; status?: string; message?: string; opensAt?: string }
  | { ok: false; error: string };

export default function CheckinClient() {
  const sp = useSearchParams();

  const token = sp.get("token") ?? "";
  const sessionStart = sp.get("sessionStart") ?? "";

  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string>("");

  const canSubmit = useMemo(() => {
    return email.trim().length > 3 && email.includes("@") && token.length > 10 && sessionStart.length > 10;
  }, [email, token, sessionStart]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    setMsg("");

    try {
      const res = await fetch(`/api/checkin?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, sessionStart }),
      });

      const json = (await res.json().catch(() => null)) as ApiResp | null;

      if (!res.ok || !json) {
        throw new Error("Request failed");
      }

      if ("ok" in json && json.ok === false) {
        throw new Error(json.error || "Request failed");
      }

      // ok:true response
      const statusLine = (json as any)?.status ? String((json as any).status) : "";
      const messageLine = (json as any)?.message ? String((json as any).message) : "";

      // Only treat "approved:true" as a true success
      if ((json as any).approved === true) {
        setState("done");
        setMsg(messageLine || "Checked in successfully.");
        return;
      }

      // approved:false (delayed / too early / no RSVP / waiver not signed)
      setState("done");
      setMsg(messageLine || statusLine || "Check-in delayed.");
    } catch (err: any) {
      setState("error");
      setMsg(err?.message || "Something went wrong.");
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
      <h1>Check In</h1>

      {!token || !sessionStart ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 12 }}>
          <b>Missing QR parameters.</b>
          <div style={{ marginTop: 6, color: "#64748b", fontSize: 13 }}>
            This page must be opened from the session QR code so it includes <code>token</code> and{" "}
            <code>sessionStart</code>.
          </div>
        </div>
      ) : null}

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 10, marginTop: 16 }}>
        <label style={{ fontSize: 13, color: "#334155" }}>
          Member Email
          <input
            type="email"
            required
            placeholder="member@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
          />
        </label>

        <button
          type="submit"
          disabled={state === "loading" || !canSubmit}
          style={{ padding: "10px 14px" }}
        >
          {state === "loading" ? "Checking…" : "Check In"}
        </button>
      </form>

      {msg ? (
        <div style={{ marginTop: 14, padding: 12, border: "1px solid #e5e7eb", borderRadius: 12 }}>
          {msg}
        </div>
      ) : null}
    </main>
  );
}