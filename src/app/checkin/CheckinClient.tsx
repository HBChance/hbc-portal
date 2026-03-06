"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type ApiResp =
  | { ok: true; approved: true; status?: string; message?: string }
  | { ok: true; approved: false; status?: string; message?: string; opensAt?: string; closesAt?: string }
  | { ok: false; error: string; message?: string };

type SessionResp =
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

  async function loadCurrentSession() {
  try {
    setRefreshing(true);

    // IMPORTANT: this endpoint should return the "active" session if one is within the check-in window,
    // otherwise return the next upcoming session.
    const res = await fetch("/api/checkin/current-session", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as SessionResp | null;

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
    if (!sessionStart) loadCurrentSession();
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
    <main style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 20,
          padding: 20,
          background: "#ffffff",
          boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
        }}
      >
        <h1 style={{ fontSize: 32, margin: 0, lineHeight: 1.1 }}>Check In</h1>
        <p style={{ marginTop: 10, marginBottom: 0, fontSize: 18, color: "#334155" }}>
          Enter your email to begin.
        </p>

        {missingToken ? (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              border: "1px solid #fecaca",
              background: "#fff7f7",
              borderRadius: 14,
            }}
          >
            <b>Missing QR token.</b>
            <div style={{ marginTop: 6, color: "#64748b", fontSize: 13 }}>
              Please scan the session QR code again (or ask the coordinator for help).
            </div>
          </div>
        ) : null}

        {token ? (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              border: "1px solid #e5e7eb",
              borderRadius: 14,
              background: "#f8fafc",
            }}
          >
            <div style={{ fontSize: 13, color: "#334155" }}>
              <b>Session:</b> {sessionLabel || "Loading…"}
            </div>

            <button
              type="button"
              onClick={loadCurrentSession}
              style={{
                marginTop: 10,
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: "#fff",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              {refreshing ? "Refreshing..." : "Refresh session"}
            </button>
          </div>
        ) : null}

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 14, marginTop: 20 }}>
          <div
            style={{
              border: "2px solid #111827",
              borderRadius: 18,
              padding: 16,
              background: "#ffffff",
            }}
          >
            <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#111827" }}>
              Member Email
            </label>
            <input
              type="email"
              required
              placeholder="member@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                padding: 16,
                marginTop: 10,
                fontSize: 20,
                borderRadius: 14,
                border: "2px solid #d1d5db",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <button
            type="submit"
            disabled={state === "loading" || !canSubmit}
            style={{
              padding: "16px 18px",
              fontSize: 18,
              fontWeight: 600,
              borderRadius: 16,
              border: "none",
              background: state === "loading" || !canSubmit ? "#cbd5e1" : "#111827",
              color: "#ffffff",
              cursor: state === "loading" || !canSubmit ? "not-allowed" : "pointer",
            }}
          >
            {state === "loading" ? "Checking…" : "Check In"}
          </button>
        </form>

        {msg ? (
          <div
            style={{
              marginTop: 16,
              padding: 14,
              border: "1px solid #e5e7eb",
              borderRadius: 14,
              background: "#f8fafc",
              fontSize: 15,
            }}
          >
            {msg}
          </div>
        ) : null}
      </div>
    </main>
  );
}