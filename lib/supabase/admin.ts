import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// SERVER-ONLY. Uses the service role key, which bypasses RLS entirely.
// Only ever import this from Server Actions / Route Handlers, never from
// anything that could run in the browser.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
