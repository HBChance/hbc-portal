"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

export default function ResetPasswordPage() {
  const supabase = createSupabaseBrowserClient();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ maxWidth: 420, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Set a new password</h1>

      <label style={{ display: "block", marginTop: 16, fontSize: 12 }}>New password</label>
      <input
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        style={{ width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 10 }}
      />

      <label style={{ display: "block", marginTop: 12, fontSize: 12 }}>Confirm new password</label>
      <input
        type="password"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
        style={{ width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 10 }}
      />

      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setMsg(null);
          if (!pw || pw.length < 8) return setMsg("Password must be at least 8 characters.");
          if (pw !== pw2) return setMsg("Passwords do not match.");

          setBusy(true);
          const { error } = await supabase.auth.updateUser({ password: pw });
          setBusy(false);

          if (error) return setMsg(error.message);

          setMsg("Password updated. You can now open /admin.");
        }}
        style={{
          marginTop: 16,
          width: "100%",
          padding: 10,
          borderRadius: 10,
          border: "1px solid #e5e7eb",
          background: "white",
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Updating…" : "Update password"}
      </button>

      {msg ? <p style={{ marginTop: 12, color: "#334155", fontSize: 13 }}>{msg}</p> : null}
    </div>
  );
}