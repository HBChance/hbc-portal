"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type ApiResp =
  | { ok: true; approved: true; status?: string; message?: string }
  | { ok: true; approved: false; status?: string; message?: string; opensAt?: string; closesAt?: string }
  | { ok: false; error: string; message?: string };

type NextSessionResp =
  | { ok: true; sessionStart: string }
  | { ok: false; error: string };

function fmtLa(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CheckinClient() {
  const sp = useSearchParams();
  const token = sp.get("token") ?? "";

  // Permanent QR will usually have token only (no sessionStart).
  const [sessionStart, setSessionStart] = useState<string>(sp.get("sessionStart") ?? "");
  const [sessionLabel, setSessionLabel] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string>("");

  const missingToken = !token;

  async function loadNextSession() {
  try {
    setRefreshing(true);

    const res = await fetch("/api/checkin/next-session", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as NextSessionResp | null;

    if (!res.ok || !json || json.ok !== true || !json.sessionStart) {
      setSessionStart("");
      setSessionLabel("Unable to load session. Please ask the coordinator.");
      return;
    }

    setSessionStart(json.sessionStart);
  } catch {
    setSessionStart("");
    setSessionLabel("Unable to load session. Please ask the coordinator.");
  } finally {
    setRefreshing(false);
  }
}

  // If sessionStart isn't provided by URL (permanent QR), load next session automatically.
  useEffect(() => {
    if (!sessionStart) loadNextSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever sessionStart changes, compute label exactly once
  useEffect(() => {
    if (!sessionStart) return;
    setSessionLabel(`${fmtLa(sessionStart)} (America/Los_Angeles)`);
  }, [sessionStart]);

  const canSubmit = useMemo(() => {
    return (
      email.trim().length > 3 &&
      email.includes("@") &&
      token.length > 10 &&
      sessionStart.length > 10
    );
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

      if (!res.ok || !json) throw new Error("Request failed");

      if ("ok" in json && json.ok === false) {
        throw new Error(json.message || json.error || "Request failed");
      }

      const statusLine = (json as any)?.status ? String((json as any).status) : "";
      const messageLine = (json as any)?.message ? String((json as any).message) : "";

      setState("done");
      setMsg(messageLine || statusLine || "Check-in processed.");
    } catch (err: any) {
      setState("error");
      setMsg(err?.message || "Something went wrong.");
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px" }}>
      <h1>Check In</h1>

      {missingToken ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 12 }}>
          <b>Missing QR token.</b>
          <div style={{ marginTop: 6, color: "#64748b", fontSize: 13 }}>
            Please scan the session QR code again (or ask the coordinator for help).
          </div>
        </div>
      ) : null}

      {token ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 12 }}>
          <div style={{ fontSize: 13, color: "#334155" }}>
            <b>Session:</b>{" "}
            {sessionLabel || "Loading…"}
          </div>

        <button
  type="button"
  onClick={loadNextSession}
  style={{
    marginTop: 10,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
  }}
>
  {refreshing ? "Refreshing..." : "Refresh session"}
</button>
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

        <button type="submit" disabled={state === "loading" || !canSubmit} style={{ padding: "10px 14px" }}>
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