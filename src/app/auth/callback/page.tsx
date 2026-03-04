"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

export default function AuthCallbackPage() {
  const supabase = createSupabaseBrowserClient();
  const router = useRouter();
  const [msg, setMsg] = useState("Completing sign-in…");

  useEffect(() => {
    (async () => {
      try {
        // For recovery links that return #access_token=... (hash fragment),
        // Supabase JS can parse the URL and persist the session automatically.
        // We just need to call getSession() to ensure it's loaded.
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (!data.session) {
          setMsg("No session found. Please request a new reset email.");
          return;
        }

        // If this was a recovery link, send them to reset-password UI
        router.replace("/reset-password");
      } catch (e: any) {
        setMsg(e?.message || "Callback failed. Please request a new reset email.");
      }
    })();
  }, [router, supabase]);

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>HBC Portal</h1>
      <p style={{ marginTop: 12, color: "#334155" }}>{msg}</p>
    </main>
  );
}