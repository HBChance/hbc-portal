import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

// IMPORTANT: reuse the real check-in route (single source of truth)
import { POST as checkinPOST } from "@/app/api/checkin/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabaseAuth = await createSupabaseServerClient();

  // auth
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabaseAuth
    .from("members")
    .select("id,is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const email = body?.email ? String(body.email).trim() : null;
  const sessionStart = body?.sessionStart ? String(body.sessionStart).trim() : null;

  if (!email) return NextResponse.json({ ok: false, error: "email is required" }, { status: 400 });

  const token = process.env.CHECKIN_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "Server missing CHECKIN_TOKEN" }, { status: 500 });
  }

  // Construct a Request to the real check-in route, server-side (token never exposed to client)
  const url = `http://localhost/api/checkin?token=${encodeURIComponent(token)}`;

  const proxyReq = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      // allow null/empty so the server can still do active-window matching
      sessionStart: sessionStart || null,
      // optional: include a marker so logs can distinguish admin manual check-ins
      source: "admin_manual",
    }),
  });

  // Delegate to the real handler
  return checkinPOST(proxyReq);
}