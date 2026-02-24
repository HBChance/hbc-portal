import { Suspense } from "react";
import CheckinClient from "./CheckinClient";

export const dynamic = "force-dynamic";

export default function CheckinPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading…</div>}>
      <CheckinClient />
    </Suspense>
  );
}