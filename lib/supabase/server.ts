import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// For Server Components / Server Actions / Route Handlers.
// Uses the anon key + the signed-in user's session cookie, so RLS still applies.
export async function createClient() {
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
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component (no request/response to write
            // cookies to) — safe to ignore because proxy.ts refreshes the
            // session on every request anyway.
          }
        },
      },
    }
  );
}
