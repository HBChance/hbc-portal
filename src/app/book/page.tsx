import { redirect } from "next/navigation";

export default async function BookPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams?.token?.trim();

  if (!token) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Missing booking link</h1>
        <p>Please use the booking link from your email.</p>
      </main>
    );
  }

  // Server-side redeem (single-use) then redirect
  const res = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL}/api/booking-pass/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // cache: "no-store" is default in Route Handlers, but we keep it explicit
    cache: "no-store",
    body: JSON.stringify({ token }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data?.redirect_url) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Booking link unavailable</h1>
        <p>{data?.error ?? "This link may be expired or already used."}</p>
      </main>
    );
  }

  redirect(data.redirect_url);
}
