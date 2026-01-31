import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function createSupabaseServerClient() {
  // In Next.js 16, cookies() is async
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // In some Next.js server contexts, cookies are read-only.
          // We'll attempt to set, and safely ignore if not allowed.
          cookiesToSet.forEach(({ name, value, options }) => {
            try {
              (cookieStore as any).set(name, value, options);
            } catch {
              // no-op in read-only contexts
            }
          });
        },
      },
    }
  );
}
