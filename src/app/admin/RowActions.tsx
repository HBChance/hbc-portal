"use client";

import { useState } from "react";

export function RowActions({
  email,
  memberId,
  waiverStatus,
  balance,
}: {
  email: string | null;
  memberId: string;
  waiverStatus?: "missing" | "sent" | "signed";
  balance?: number;
}) {
  type Busy = "booking" | "waiver" | "credit" | "remind" | "checkwaiver" | "noshow" | "manualcheckin" | "offer" | null;
const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<string | null>(null);
function fmtSessionChoice(iso: string) {
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
  async function postJson(url: string, body: any) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    if (data && data.ok === false) throw new Error(data?.error || "Request failed");
    return data;
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={busy !== null}
        onClick={async () => {
          setMsg(null);
          setBusy("credit");
          try {
            await postJson("/api/admin/credits/add", {
              member_id: memberId,
              quantity: 1,
              reason: "admin +1 credit",
            });
            setMsg("+1 credit added");
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
        title="Add +1 credit (ledger grant)"
      >
        +1 credit
      </button>
      <button
        type="button"
        disabled={!email || busy !== null || (balance ?? 0) < 1}
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
          opacity: busy !== null || !email || (balance ?? 0) < 1 ? 0.5 : 1,
	  cursor: busy !== null || !email || (balance ?? 0) < 1 ? "not-allowed" : "pointer",

        }}
        title={
  !email
    ? "Missing email"
    : (balance ?? 0) < 1
    ? "Member has no credits"
    : "Send booking link email"
}
      >
        {busy === "booking" ? "Sending…" : "Send booking link"}
      </button>

      <button
        type="button"
        disabled={busy !== null || waiverStatus === "signed"}
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
          opacity: busy !== null || waiverStatus === "signed" ? 0.5 : 1,
	  cursor: busy !== null || waiverStatus === "signed" ? "not-allowed" : "pointer",

        }}
        title={waiverStatus === "signed" ? "Already signed" : "Send annual waiver via SignNow"}
      >
        {busy === "waiver" ? "Sending…" : "Send waiver"}
      </button>
<button
  type="button"
  disabled={busy !== null}
  onClick={async () => {
    setMsg(null);
    setBusy("checkwaiver");
    try {
      const out = await postJson("/api/admin/waiver/check", { member_id: memberId });
setMsg(`Checked waivers: ${out.marked_signed} marked signed (checked ${out.checked})`);
console.log("[waiver-check] response", out);
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
  title="Check SignNow status for this member's unsigned waivers and mark signed"
>
  {busy === "checkwaiver" ? "Checking…" : "Check waivers"}
</button>
      <button
        type="button"
        disabled={busy !== null || waiverStatus === "signed"}
        onClick={async () => {
          setMsg(null);
          setBusy("remind");
          try {
            await postJson("/api/admin/waiver/remind", { member_id: memberId });
            setMsg("Waiver reminder sent");
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
          opacity: busy !== null || waiverStatus === "signed" ? 0.5 : 1,
          cursor: busy !== null || waiverStatus === "signed" ? "not-allowed" : "pointer",
        }}
        title={waiverStatus === "signed" ? "Already signed" : "Send reminder + resend SignNow invite(s) (no duplicates)"}
      >
        {busy === "remind" ? "Sending…" : "Remind waiver"}
      </button>
<button
  type="button"
  disabled={busy !== null}
  onClick={async () => {
    setMsg(null);

    const rsvpId = window.prompt("Paste RSVP ID to mark as NO-SHOW:");
    if (!rsvpId) return;

    setBusy("noshow");
    try {
      await postJson("/api/admin/noshow/mark", { rsvp_id: rsvpId.trim() });
      setMsg("No-show marked");
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
  title="Mark a specific RSVP as a no-show (only allowed after check-in closes)"
>
  {busy === "noshow" ? "Marking…" : "Mark no-show"}
</button>
<button
  type="button"
  disabled={busy !== null}
  onClick={async () => {
    setMsg(null);

    const inviteeEmail = window.prompt(
      "Enter attendee email to manually check in:",
      (email ?? "").trim()
    );
    if (!inviteeEmail) return;

    setBusy("manualcheckin");
    try {
      const lookup = await postJson("/api/admin/checkin/manual", {
        email: inviteeEmail.trim(),
        lookup: true,
      });

      const sessions = Array.isArray(lookup?.sessions) ? lookup.sessions : [];

      if (sessions.length === 0) {
        setMsg(
          lookup?.message ||
            "No eligible booked sessions found for this attendee. They may need to book a session or may already be checked in."
        );
        return;
      }

      let chosen = sessions[0];

      if (sessions.length > 1) {
        const optionsText = sessions
          .map((s: any, i: number) => `${i + 1}. ${s.label || fmtSessionChoice(s.event_start_at)}`)
          .join("\n");

        const picked = window.prompt(
          `Choose session for manual check-in:\n\n${optionsText}\n\nEnter the number of the session:`,
          "1"
        );

        if (!picked) return;

        const idx = Number(picked) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= sessions.length) {
          throw new Error("Invalid session selection");
        }

        chosen = sessions[idx];
      }

      const out = await postJson("/api/admin/checkin/manual", {
        email: inviteeEmail.trim(),
        selected_rsvp_id: chosen.rsvp_id,
      });

      if (out?.inserted === false && out?.reason === "already_checked_in") {
        setMsg(`Already checked in — ${chosen.label || fmtSessionChoice(chosen.event_start_at)}`);
      } else {
        setMsg(`Checked in — ${chosen.label || fmtSessionChoice(chosen.event_start_at)}`);
      }

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
  title="Manually check in an attendee (uses current session window if sessionStart is blank)"
>
  {busy === "manualcheckin" ? "Checking…" : "Manual check-in"}
</button>
<button
  type="button"
  disabled={!email || busy !== null}
  onClick={async () => {
    setMsg(null);
    setBusy("offer");
    try {
      await postJson("/api/admin/membership-offer/send", { member_id: memberId });
      setMsg("Membership offer sent");
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
    opacity: busy !== null || !email ? 0.5 : 1,
    cursor: busy !== null || !email ? "not-allowed" : "pointer",
  }}
  title={!email ? "Missing email" : "Send membership offer email ($33 / $66)"}
>
  {busy === "offer" ? "Sending…" : "Send membership offer"}
</button>
      {msg ? <span style={{ fontSize: 12, color: "#64748b" }}>{msg}</span> : null}
    </div>
  );
}
