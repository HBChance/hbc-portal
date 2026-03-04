import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  // If Supabase is using PKCE flow, it will send `?code=...`
  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // If exchange fails, send them to login with a hint
      return NextResponse.redirect(new URL(`/login?error=oauth_callback_failed`, url.origin));
    }
  }

  // After session is set, send them to a reset password page
  return NextResponse.redirect(new URL(`/reset-password`, url.origin));
}