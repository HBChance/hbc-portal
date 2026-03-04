"use client";

import { useEffect } from "react";

export default function HomePage() {
  useEffect(() => {
    // Supabase recovery links often land on Site URL with a hash fragment:
    //   /#access_token=...&type=recovery
    // The server never sees hashes, so we redirect client-side to /auth/callback
    // while preserving the hash.
    const hash = window.location.hash || "";
    const isRecovery = hash.includes("type=recovery") && hash.includes("access_token=");
    if (isRecovery) {
      window.location.replace(`/auth/callback${hash}`);
    }
  }, []);

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>HBC Portal (Fresh Build)</h1>
      <p style={{ marginTop: 12, color: "#334155" }}>Supabase connection will be tested next.</p>
    </main>
  );
}