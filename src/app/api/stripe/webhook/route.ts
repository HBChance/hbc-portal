import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRole) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const supabaseAdmin = createClient(supabaseUrl, serviceRole);

/**
 * Map Stripe PRICE IDs -> credits.
 * Use TEST price IDs while in test mode.
 */
const PRICE_TO_CREDITS: Record<string, number> = {
  // One-time $45 (TEST)
  "price_1Sq1PW74RZAQay6edMvp2D58": 1,

  // Monthly membership $33 (TEST) — ACTUAL from invoice log
  "price_1SnXJM74RZAQay6ecf6zGUaZ": 1,

  // Monthly membership $66 (TEST) — ACTUAL from invoice log
  "price_1SnXOq74RZAQay6eC51mfDPa": 4,
};

async function alreadyProcessed(eventId: string) {
  const { data } = await supabaseAdmin
    .from("stripe_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();
  return !!data;
}

async function markProcessed(eventId: string, eventType: string) {
  await supabaseAdmin.from("stripe_events").insert({
    event_id: eventId,
    event_type: eventType,
  });
}

async function getOrCreateMemberByEmail(opts: {
  email: string;
  phone?: string | null;
  fullName?: string | null;
}) {
  const emailNormalized = opts.email.trim().toLowerCase();

  // Try existing member
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("members")
    .select("id,email,phone")
    .eq("email", emailNormalized)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.id) {
    // Stripe may have a better phone number — safe to backfill phone only
    if (!existing.phone && opts.phone) {
      await supabaseAdmin
        .from("members")
        .update({ phone: opts.phone })
        .eq("id", existing.id);
    }
    return existing.id as string;
  }

  // Create member row WITHOUT names — Calendly will populate attendee name later
  const { data: created, error: createError } = await supabaseAdmin
    .from("members")
    .insert({
      user_id: null,
      email: emailNormalized,
      first_name: null,
      last_name: null,
      phone: opts.phone ?? null,
      newsletter_opt_in: false,
      is_admin: false,
    })
    .select("id")
    .single();

  if (createError) throw createError;
  return created.id as string;
}
async function creditGrantExistsForSession(
  memberId: string,
  stripeSessionId: string
) {
  const { data, error } = await supabaseAdmin
    .from("credits_ledger")
    .select("id")
    .eq("member_id", memberId)
    .eq("entry_type", "grant")
    .ilike("reason", `%${stripeSessionId}%`)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

async function grantCredits(memberId: string, qty: number, reason: string) {
  if (!qty || qty === 0) return;

  const { error } = await supabaseAdmin.from("credits_ledger").insert({
    member_id: memberId,
    entry_type: "grant",
    quantity: qty,
    reason,
    created_by: null,
  });

  if (error) throw new Error(`Failed inserting credits: ${error.message}`);
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  // IMPORTANT: must verify signature using raw bytes
  const buf = Buffer.from(await req.arrayBuffer());

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("[stripe] signature verification failed:", err?.message);
    return new Response(`Webhook Error: ${err?.message}`, { status: 400 });
  }

  try {
    console.log("[stripe] event received:", event.type, event.id);

    if (await alreadyProcessed(event.id)) {
      return new Response("Already processed", { status: 200 });
    }

    // ONE-TIME PURCHASES
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // Ignore subscription checkouts to avoid double-credit
      if (session.mode === "subscription") {
        await markProcessed(event.id, event.type);
        return new Response("Subscription checkout ignored", { status: 200 });
      }

      if (session.payment_status && session.payment_status !== "paid") {
        await markProcessed(event.id, event.type);
        return new Response("Not paid", { status: 200 });
      }

      const email =
        session.customer_details?.email ||
        session.customer_email ||
        undefined;

      if (!email) throw new Error("No customer email on checkout session");
	const fullName = session.customer_details?.name ?? null;
	const phone = session.customer_details?.phone ?? null;

      // --- CREDITS: one-time purchase computation (LIVE-safe) ---
const metaCreditsRaw =
  session.metadata?.credits ??
  session.metadata?.credit ??
  session.metadata?.booking_credits ??
  null;

let credits =
  metaCreditsRaw != null ? Number.parseInt(String(metaCreditsRaw), 10) : 0;

// If metadata isn't present/valid, fall back to line item price mapping.
let lineItems: Stripe.ApiList<Stripe.LineItem> | null = null;

if (!Number.isFinite(credits) || credits <= 0) {
  lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
  });

  credits = 0;
  for (const li of lineItems.data) {
    const priceId = (li.price as any)?.id as string | undefined;
    const qty = li.quantity ?? 1;
    const per = priceId ? (PRICE_TO_CREDITS[priceId] ?? 0) : 0;
    credits += per * qty;
  }
}

// Final fallback for the $45 guest pass in LIVE
if (!Number.isFinite(credits) || credits <= 0) {
  const purchaseType = session.metadata?.purchase_type;
  const amountTotal = session.amount_total ?? 0; // cents

  if (purchaseType === "guest_pass" || amountTotal === 4500) {
    credits = 1;
  }
}

console.log("[stripe] checkout credits computed:", credits, {
  sessionId: session.id,
  mode: session.mode,
  amount_total: session.amount_total,
  purchase_type: session.metadata?.purchase_type,
  meta_credits: session.metadata?.credits,
  line_items: lineItems?.data?.length ?? "not_fetched",
});

// Never silently "succeed" with 0 credits again.
if (!Number.isFinite(credits) || credits <= 0) {
  throw new Error(
    `Unable to compute credits for checkout session ${session.id} (amount_total=${session.amount_total}, purchase_type=${session.metadata?.purchase_type}, meta_credits=${session.metadata?.credits})`
  );
}
// --- end credits computation ---


      if (credits > 0) {

      const memberId = await getOrCreateMemberByEmail({
        email,
        fullName,
        phone,
      });

      const alreadyGranted = await creditGrantExistsForSession(memberId, session.id);

      if (!alreadyGranted) {
        await grantCredits(
          memberId,
          credits,
          `stripe checkout.session.completed | session=${session.id} | event=${event.id}`
        );
      }


         // PHASE 1.5 — Store guest profile for future prefill
      const stripeCustomerId =
        typeof session.customer === "string" ? session.customer : null;

      // Upsert by normalized email so repeated purchases just update the same row
      await supabaseAdmin
        .from("guest_profiles")
        .upsert(
          {
            email,
            full_name: fullName,
            phone,
            stripe_customer_id: stripeCustomerId,
            last_stripe_session_id: session.id,
            last_purchase_at: new Date().toISOString(),
          },
          { onConflict: "email_normalized" }
        );

      // PHASE 1.5B — Create one-time booking pass + email it (idempotent)
      const { data: existingPass } = await supabaseAdmin
        .from("booking_passes")
        .select("id, member_id")
        .eq("stripe_session_id", session.id)
        .maybeSingle();

      if (existingPass) {
        // Backfill linkage for older/orphaned pass rows
        if (!existingPass.member_id) {
          await supabaseAdmin
            .from("booking_passes")
            .update({ member_id: memberId })
            .eq("id", existingPass.id);
        }

        await markProcessed(event.id, event.type);
        return new Response("OK (pass already existed)", { status: 200 });
      }

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Buffer.from(tokenBytes).toString("base64url"); // URL-safe
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await supabaseAdmin.from("booking_passes").insert({
        token,
        email,
        stripe_session_id: session.id,
        expires_at: expiresAt,
        member_id: memberId, // ALWAYS link at creation time
      });

      // This is your single-use gate (no Squarespace page needed)
      const bookingUrl =
        `https://vffglvixaokvtdrdpvtd.functions.supabase.co/redeem-booking-pass?token=${token}`;


     const html = `
  <p>Thank you for your purchase.</p>

  <p>
    <a href="${bookingUrl}">
      <strong>Click here to book your Flintridge Sound Bath</strong>
    </a>
  </p>

  <p>
    This link can be clicked <strong>once</strong> and expires <strong>30 days</strong> from when you received this email.
  </p>

  <p>
    If you click the link and can’t complete booking, email 
    <a href="mailto:help@happensbychance.com">help@happensbychance.com</a> 
    with a description of what happened and we’ll resend a new link to this address.
  </p>
`;

      // Send email via Edge Function (Resend)
      await fetch(
        "https://vffglvixaokvtdrdpvtd.functions.supabase.co/send-booking-pass",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-cron-key": process.env.CRON_INVOKE_KEY!,
          },
          body: JSON.stringify({
            to: email,
            subject: "Your booking link — Happens By Chance",
            html,
          }),
        }
      );

      await markProcessed(event.id, event.type);
      return new Response("OK", { status: 200 });
    }

    } // <-- ADD THIS LINE to close: if (credits > 0) {

    // SUBSCRIPTIONS / RENEWALS
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;

      // Re-fetch invoice with expanded line prices (bulletproof)
      const fullInvoice = await stripe.invoices.retrieve(invoice.id, {
        expand: ["lines.data.price"],
      });

     // Resolve customer email from invoice (Invoice does NOT have customer_details)
let email: string | undefined =
  fullInvoice.customer_email ||
  (typeof fullInvoice.customer === "object" ? (fullInvoice.customer as any)?.email : undefined);

if (!email && typeof fullInvoice.customer === "string") {
  const cust = (await stripe.customers.retrieve(fullInvoice.customer)) as any;
  email = cust?.email || undefined;
}

if (!email) throw new Error("No customer email on invoice");

      let credits = 0;
      const lines = fullInvoice.lines?.data ?? [];

     for (const line of lines as any[]) {
  // Stripe can put price info in different places depending on API version.
  const priceId =
    line?.price?.id ||
    line?.pricing?.price_details?.price ||                 // sometimes a string like "price_..."
    line?.pricing?.price_details?.price?.id ||             // sometimes an object
    line?.plan?.id ||                                      // older subscription shapes
    line?.plan;                                            // sometimes a string

  const qty = line.quantity ?? 1;
  const per = priceId ? (PRICE_TO_CREDITS[String(priceId)] ?? 0) : 0;
  credits += per * qty;
}


      console.log(
  "[stripe] invoice price IDs:",
  (lines as any[]).map((l) => ({
    price:
      l?.price?.id ||
      l?.pricing?.price_details?.price?.id ||
      l?.pricing?.price_details?.price ||
      l?.plan?.id ||
      l?.plan,
    qty: l.quantity ?? 1,
    desc: l.description,
  }))
);

      console.log("[stripe] invoice credits computed:", credits);

      if (credits > 0) {
        const memberId = await getOrCreateMemberByEmail({ email });
        await grantCredits(memberId, credits, `Stripe invoice (${fullInvoice.id})`);
      }

      await markProcessed(event.id, event.type);
      return new Response("OK", { status: 200 });
    }

        // Default: record + ignore
    await markProcessed(event.id, event.type);
    return new Response("Ignored", { status: 200 });
  } catch (err: any) {
    console.error("[stripe] handler error:", err?.message);
    return new Response(`Handler Error: ${err?.message}`, { status: 500 });
  }
}
