"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

export default function LoginPage() {
  const supabase = createSupabaseBrowserClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [status, setStatus] = useState<string>("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Working...");

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setStatus("Signed up! Now switch to Sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setStatus("Signed in! Go to /app.");
      }
    } catch (err: any) {
      setStatus(err?.message ?? "Something went wrong");
    }
  }

  return (
    <main className="p-6 max-w-md">
      <h1 className="text-2xl font-semibold">HBC Portal Login</h1>

      <div className="mt-4 flex gap-2">
        <button
          className={`px-3 py-2 rounded border ${mode === "signup" ? "bg-black text-white" : ""}`}
          onClick={() => setMode("signup")}
          type="button"
        >
          Sign up
        </button>
        <button
          className={`px-3 py-2 rounded border ${mode === "signin" ? "bg-black text-white" : ""}`}
          onClick={() => setMode("signin")}
          type="button"
        >
          Sign in
        </button>
      </div>

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
        />
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          required
        />
        <button className="w-full rounded px-3 py-2 bg-black text-white" type="submit">
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
        <p className="text-sm text-gray-600">{status}</p>
      </form>
    </main>
  );
}
