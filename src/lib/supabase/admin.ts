import { createClient } from "@supabase/supabase-js";

// Service-level Supabase client for admin operations (deleting an auth user). Uses the secret key, so it must
// only ever be imported by server code; the key has no NEXT_PUBLIC_ prefix and never reaches the browser.
export function createAdminClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not configured.");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
