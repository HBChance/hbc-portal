"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

export default function LoginPage() {
  const supabase = createSupabaseBrowserClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [status, setStatus] = useState<string>("");
  async function onForgotPassword() {
    setStatus("Sending password reset email...");

    try {
      if (!email || !email.includes("@")) {
        setStatus("Enter your email above first.");
        return;
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: "https://hbc-portal.vercel.app/auth/callback",
      });

      if (error) throw error;
      setStatus("Password reset email sent. Check your inbox.");
    } catch (err: any) {
      setStatus(err?.message ?? "Failed to send reset email");
    }
  }
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
    <main className="min-h-screen bg-white px-6 py-10">
      <div className="mx-auto max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">HBC Portal</h1>
        <p className="mt-3 text-base text-gray-700">
          Enter your email to begin.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div className="rounded-2xl border-2 border-black bg-white p-4 shadow-sm">
            <label className="mb-2 block text-sm font-medium text-gray-800">
              Email address
            </label>
            <input
              className="w-full rounded-xl border-2 border-gray-300 px-4 py-4 text-lg outline-none transition focus:border-black"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              autoFocus
            />
          </div>

          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <label className="mb-2 block text-sm font-medium text-gray-800">
              Password
            </label>
            <input
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-base outline-none transition focus:border-black"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              className={`rounded-xl border px-4 py-2 text-sm font-medium ${
                mode === "signup" ? "bg-black text-white" : "bg-white text-black"
              }`}
              onClick={() => setMode("signup")}
              type="button"
            >
              Sign up
            </button>
            <button
              className={`rounded-xl border px-4 py-2 text-sm font-medium ${
                mode === "signin" ? "bg-black text-white" : "bg-white text-black"
              }`}
              onClick={() => setMode("signin")}
              type="button"
            >
              Sign in
            </button>
          </div>

          <button
            className="w-full rounded-xl bg-black px-4 py-3 text-base font-medium text-white"
            type="submit"
          >
            {mode === "signup" ? "Create account" : "Sign in"}
          </button>

          {mode === "signin" ? (
            <button
              type="button"
              onClick={onForgotPassword}
              className="text-sm underline text-gray-700"
            >
              Forgot password?
            </button>
          ) : null}

          {status ? <p className="text-sm text-gray-600">{status}</p> : null}
        </form>
      </div>
    </main>
  );
}
