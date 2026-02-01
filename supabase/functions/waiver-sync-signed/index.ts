import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RunSummary = {
  scanned: number;
  updated: number;
  already_signed: number;
  errors: Array<{
    waiver_id?: string;
    external_document_id?: string;
    message: string;
  }>;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Defensive “completed” detection across possible SignNow payload variants.
function looksSigned(doc: any): boolean {
  const status = (doc?.status ?? "").toString().toLowerCase();
  const documentStatus = (doc?.document_status ?? "").toString().toLowerCase();
  const signingStatus = (doc?.signing_status ?? "").toString().toLowerCase();

  if (status === "completed" || status === "signed") return true;
  if (documentStatus === "completed" || documentStatus === "signed") return true;
  if (signingStatus === "completed" || signingStatus === "signed") return true;
  if (doc?.is_completed === true) return true;

  // Some SignNow payloads track completion per-invite
  // In your real payload, invite status is "fulfilled" when the signer is done.
  if (Array.isArray(doc?.field_invites) && doc.field_invites.length > 0) {
    const allDone = doc.field_invites.every((i: any) =>
      ["fulfilled", "completed", "signed"].includes(
        ((i?.status ?? "") as string).toLowerCase()
      )
    );
    if (allDone) return true;
  }

    // Some payloads track signatures separately.
  // BUT your payload shows signatures[].status can be null even when invites are fulfilled,
  // so we treat signatures as a "bonus signal", not a requirement.
  if (Array.isArray(doc?.signatures) && doc.signatures.length > 0) {
    const anySigDone = doc.signatures.some((s: any) =>
      ["fulfilled", "completed", "signed"].includes(
        ((s?.status ?? "") as string).toLowerCase()
      )
    );
    if (anySigDone) return true;
  }

  return false;
}

serve(async (req) => {
  // Require shared secret header so only cron can invoke
  const cronKey = Deno.env.get("CRON_INVOKE_KEY") ?? "";
  const gotKey = req.headers.get("x-cron-key") ?? "";
  if (!cronKey || gotKey !== cronKey) {
    return json(401, { error: "Unauthorized" });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // IMPORTANT: These env var names must match what you already use in your working SignNow setup.
  const SIGNNOW_API_BASE = Deno.env.get("SIGNNOW_API_BASE") ?? "https://api.signnow.com";
const SIGNNOW_BEARER_TOKEN = Deno.env.get("SIGNNOW_BEARER_TOKEN"); // optional if you ever add it
const SIGNNOW_BASIC_AUTH = Deno.env.get("SIGNNOW_BASIC_AUTH"); // base64(client_id:client_secret)
const SIGNNOW_USERNAME = Deno.env.get("SIGNNOW_USERNAME");
const SIGNNOW_PASSWORD = Deno.env.get("SIGNNOW_PASSWORD");

async function getSignNowAccessToken(): Promise<string> {
  // Prefer a pre-provided token if you ever add one later
  if (SIGNNOW_BEARER_TOKEN) return SIGNNOW_BEARER_TOKEN;

  // Otherwise, generate an access token using password grant
  if (!SIGNNOW_BASIC_AUTH || !SIGNNOW_USERNAME || !SIGNNOW_PASSWORD) {
    throw new Error(
      "Missing SignNow auth env vars. Provide SIGNNOW_BEARER_TOKEN OR (SIGNNOW_BASIC_AUTH + SIGNNOW_USERNAME + SIGNNOW_PASSWORD)."
    );
  }

  const body = new URLSearchParams({
    grant_type: "password",
    username: SIGNNOW_USERNAME,
    password: SIGNNOW_PASSWORD,
  });

  const resp = await fetch(`${SIGNNOW_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${SIGNNOW_BASIC_AUTH}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`SignNow token request failed: ${resp.status} ${resp.statusText} ${text}`.slice(0, 1000));
  }

  const tok = await resp.json().catch(() => ({}));
  const token = tok?.access_token;
  if (!token) throw new Error("SignNow token response missing access_token");
  return token;
}


  const waiverYear = new Date().getFullYear();

  const summary: RunSummary = { scanned: 0, updated: 0, already_signed: 0, errors: [] };

  // Create a run log row first (proves cron fired)
  const { data: runRow, error: runInsertErr } = await supabase
    .from("waiver_sync_runs")
    .insert({
      waiver_year: waiverYear,
      started_at: new Date().toISOString(),
      status: "running",
    })
    .select("*")
    .single();

  if (runInsertErr || !runRow) {
    return json(500, { error: "Failed to create waiver_sync_runs row", details: runInsertErr });
  }

  const runId = runRow.id as string;

  try {
    const { data: waivers, error: selectErr } = await supabase
      .from("waivers")
      .select("id, external_document_id, signed_at, status")
      .eq("waiver_year", waiverYear)
      .eq("status", "sent")
      .is("signed_at", null)
      .not("external_document_id", "is", null);

    if (selectErr) throw selectErr;

    const list = waivers ?? [];
    summary.scanned = list.length;

    for (const w of list) {
      const waiverId = w.id as string;
      const docId = w.external_document_id as string;

      if (w.status === "signed" || w.signed_at) {
        summary.already_signed += 1;
        continue;
      }

      try {
        const resp = await fetch(`${SIGNNOW_API_BASE}/document/${docId}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${await getSignNowAccessToken()}`,
            Accept: "application/json",
          },
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          summary.errors.push({
            waiver_id: waiverId,
            external_document_id: docId,
            message: `SignNow GET document failed: ${resp.status} ${resp.statusText} ${text}`.slice(0, 1000),
          });
          continue;
        }
                       const doc = await resp.json().catch(() => ({}));

        // Robust completion check (works with your "fulfilled" payload)
        const isSigned = looksSigned(doc);
        if (!isSigned) continue;

        const signedAtIso = new Date().toISOString();

        const { data: updated, error: updateErr } = await supabase
          .from("waivers")
          .update({
            status: "signed",
            signed_at: signedAtIso,
            updated_at: new Date().toISOString(),
          })
          .eq("id", waiverId)
          .eq("status", "sent")
          .is("signed_at", null)
          .select("id")
          .maybeSingle();

        if (updateErr) throw updateErr;

        if (updated?.id) summary.updated += 1;
        else summary.already_signed += 1;
      } catch (err) {
        summary.errors.push({
          waiver_id: waiverId,
          external_document_id: docId,
          message: String(err),
        });
      }
    }

    await supabase
      .from("waiver_sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: summary.errors.length ? "completed_with_errors" : "completed",
        scanned: summary.scanned,
        updated: summary.updated,
        already_signed: summary.already_signed,
        errors: summary.errors,
      })
      .eq("id", runId);

    return json(200, { run_id: runId, ...summary });
  } catch (err) {
    await supabase
      .from("waiver_sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "failed",
        errors: [{ message: String(err) }],
      })
      .eq("id", runId);

    return json(500, { run_id: runId, error: String(err) });
  }
});
