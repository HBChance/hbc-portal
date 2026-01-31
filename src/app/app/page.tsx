import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

export default async function AppHome() {
const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Get-or-create member by user_id
  const { data: existing, error: selErr } = await supabase
    .from("members")
    .select("id, email, first_name, last_name, is_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (selErr) {
    // If you hit RLS issues, we’ll address next
    throw new Error(selErr.message);
  }

  let member = existing;

  if (!member) {
    // Insert should currently be admin-only; so this may fail until we adjust policy.
    // We'll fix that in the next step by changing members_insert policy.
    const { data: created, error: insErr } = await supabase
      .from("members")
      .insert({
        user_id: user.id,
        email: user.email,
      })
      .select("id, email, first_name, last_name, is_admin")
      .single();

    if (insErr) throw new Error(insErr.message);
    member = created;
  }

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Portal</h1>
      <p className="mt-2 text-sm text-gray-700">Signed in as: {member?.email}</p>
      <p className="mt-2 text-sm text-gray-700">Admin: {member?.is_admin ? "Yes" : "No"}</p>
    </main>
  );
}
