import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { signNowGetDocument } from "@/lib/signnow";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();

  // Admin gate
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase
    .from("members")
    .select("is_admin")
    .eq("user_id", user.id)
    .single();

  if (!me?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Parse ?document_id=
  const url = new URL(req.url);
  const documentId = url.searchParams.get("document_id");
  if (!documentId) {
    return NextResponse.json({ error: "document_id query param required" }, { status: 400 });
  }

  // Fetch doc from SignNow
  const doc = await signNowGetDocument(documentId);

  // Return only the fields we care about (avoid dumping entire doc)
  return NextResponse.json({
    ok: true,
    document_id: documentId,
    top_level_status: doc?.status ?? null,
    document_status: doc?.document_status ?? null,
    signing_status: doc?.signing_status ?? null,
    is_completed: doc?.is_completed ?? null,
    field_invites: Array.isArray(doc?.field_invites)
      ? doc.field_invites.map((i: any) => ({
          id: i?.id ?? null,
          email: i?.email ?? null,
          status: i?.status ?? null,
          role: i?.role ?? null,
        }))
      : null,
    signatures: Array.isArray(doc?.signatures)
      ? doc.signatures.map((s: any) => ({
          email: s?.email ?? null,
          status: s?.status ?? null,
        }))
      : null,
    updated: doc?.updated ?? null,
    created: doc?.created ?? null,
  });
}
