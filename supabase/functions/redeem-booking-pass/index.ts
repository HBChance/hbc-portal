import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CALENDLY_BASE = "https://calendly.com/happensbychance/flintridge-sound-bath";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token = (url.searchParams.get("token") ?? "").trim();

    if (!token) {
      return new Response("Missing token", { status: 400 });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return new Response("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // 1) Fetch pass
    const { data: pass, error: fetchErr } = await supabase
      .from("booking_passes")
      .select("id, email, used_at, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (fetchErr || !pass) {
      return new Response("Invalid booking link", { status: 404 });
    }

    if (pass.used_at) {
      return new Response("This booking link has already been used.", { status: 409 });
    }

    if (new Date(pass.expires_at).getTime() <= Date.now()) {
      return new Response("This booking link has expired.", { status: 410 });
    }

    // 2) Mark used (idempotent: only if still unused)
    const { error: updErr } = await supabase
      .from("booking_passes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", pass.id)
      .is("used_at", null);

    if (updErr) {
      return new Response("Could not redeem booking link. Please try again.", { status: 500 });
    }

    // 3) Redirect to Calendly (prefill email so they don't type it)
    const redirectUrl = `${CALENDLY_BASE}?email=${encodeURIComponent(pass.email)}`;

    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });
  } catch (e) {
    return new Response("Server error", { status: 500 });
  }
});
