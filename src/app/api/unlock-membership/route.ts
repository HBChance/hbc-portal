import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

const MEMBERSHIP = {
  supportEmail: "membership@happensbychance.com",
  firstSessionLink: "https://buy.stripe.com/00w3cocLh4Ra3eW1oD3Ru05",
  oneSession: {
    title: "Ladera Ranch Sound Healing - 1 Session Monthly Membership",
    paymentLink: "https://buy.stripe.com/7sY14g6mT4Ra7vcebp3Ru07",
  },
  fourSession: {
    title: "Ladera Ranch Sound Healing - 4 Session Monthly Membership",
    paymentLink: "https://buy.stripe.com/4gMfZabHdgzSdTAebp3Ru08",
  },
};

function normEmail(v: string) {
  return v.trim().toLowerCase();
}

export async function POST(req: Request) {
  const supabase = createSupabaseAdminClient();

  const body = await req.json().catch(() => null);
  const emailRaw = String(body?.email ?? "");
  const email = normEmail(emailRaw);

  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "Valid email is required." }, { status: 400 });
  }

  // RSVP-based eligibility:
  // Count any RSVP that looks “real” (booked and redeemed), and whose event_start_at is in the past.
  // This ties to ATTENDEE email, not payer.
  const nowIso = new Date().toISOString();

  const { count, error } = await supabase
    .from("rsvps")
    .select("id", { count: "exact", head: true })
    .eq("invitee_email", email)
    .eq("status", "booked")
    .not("redeemed_ledger_id", "is", null)
    .lt("event_start_at", nowIso);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const eligible = (count ?? 0) > 0;

  if (!eligible) {
    return NextResponse.json({
      ok: true,
      eligible: false,
      message:
        "Looks like you haven’t attended your first session yet — here’s the $45 first-session link.",
      firstSessionLink: MEMBERSHIP.firstSessionLink,
      supportEmail: MEMBERSHIP.supportEmail,
    });
  }

  return NextResponse.json({
    ok: true,
    eligible: true,
    message: "You’re eligible for membership — choose an option below.",
    supportEmail: MEMBERSHIP.supportEmail,
    memberships: {
      oneSession: {
        title: MEMBERSHIP.oneSession.title,
        paymentLink: MEMBERSHIP.oneSession.paymentLink,
      },
      fourSession: {
        title: MEMBERSHIP.fourSession.title,
        paymentLink: MEMBERSHIP.fourSession.paymentLink,
      },
    },
  });
}
