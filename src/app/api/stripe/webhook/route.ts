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

async function getOrCreateMemberByEmail(email: string) {
  const norm = email.trim().toLowerCase();

  const { data: existing } = await supabaseAdmin
    .from("members")
    .select("id,email")
    .eq("email", norm)
    .maybeSingle();

  if (existing?.id) return existing;

  const { data: created, error } = await supabaseAdmin
    .from("members")
    .insert({ email: norm })
    .select("id,email")
    .single();

  if (error) throw new Error(`Failed creating member: ${error.message}`);
  return created;
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

      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 100,
      });

            // --- credits calculation (live-safe) ---
      // Priority:
      // 1) checkout.session.metadata.credits (if Stripe is sending it)
      // 2) price/product metadata credits (works for Payment Links in live)
      // 3) fallback to PRICE_TO_CREDITS mapping

      let credits = 0;

      const sessionMetaCreditsRaw = (session.metadata as any)?.credits;
      const sessionMetaCredits = sessionMetaCreditsRaw ? Number(sessionMetaCreditsRaw) : 0;
      if (Number.isFinite(sessionMetaCredits) && sessionMetaCredits > 0) {
        credits = sessionMetaCredits;
      } else {
        for (const li of lineItems.data) {
          const qty = li.quantity ?? 1;

          // Try metadata directly on the expanded price object (if present)
          const liPrice: any = li.price as any;
          let per =
            Number(liPrice?.metadata?.credits ?? 0) ||
            0;

          // If not on price, try expanding price->product and reading product metadata
          if (!per) {
            const priceId = liPrice?.id as string | undefined;
            if (priceId) {
              try {
                const fullPrice: any = await stripe.prices.retrieve(priceId, { expand: ["product"] });
                per =
                  Number(fullPrice?.metadata?.credits ?? 0) ||
                  Number(fullPrice?.product?.metadata?.credits ?? 0) ||
                  0;
              } catch {
                // ignore and fallback
              }
            }
          }

          // Final fallback: your hard-coded mapping
          if (!per) {
            const priceId = liPrice?.id as string | undefined;
            per = priceId ? (PRICE_TO_CREDITS[priceId] ?? 0) : 0;
          }

          credits += per * qty;
        }
      }
      // --- end credits calculation ---

      console.log("[stripe] checkout credits computed:", credits);

      if (credits > 0) {
        const member = await getOrCreateMemberByEmail(email);
        await grantCredits(member.id, credits, `Stripe checkout (${session.id})`);
      }

      // PHASE 1.5 — Store guest profile for future prefill
      const fullName = session.customer_details?.name ?? null;
      const phone = session.customer_details?.phone ?? null;

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

      // PHASE 1.5B — Create one-time booking pass + email it
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Buffer.from(tokenBytes).toString("base64url"); // URL-safe
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h

      await supabaseAdmin.from("booking_passes").insert({
        token,
        email,
        stripe_session_id: session.id,
        expires_at: expiresAt,
      });

     // This is your single-use gate (no Squarespace page needed)
      const bookingUrl =
        `https://vffglvixaokvtdrdpvtd.functions.supabase.co/redeem-booking-pass?token=${token}`;

      const html = `
        <p>Thank you for your purchase.</p>
        <p><a href="${bookingUrl}"><strong>Click here to book your Flintridge Sound Bath</strong></a></p>
        <p>This link can be used <strong>once</strong> and expires in <strong>48 hours</strong>.</p>
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
        const member = await getOrCreateMemberByEmail(email);
        await grantCredits(member.id, credits, `Stripe invoice (${fullInvoice.id})`);
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
