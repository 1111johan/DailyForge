import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "@/lib/config/env";

export function createSupabaseAdmin() {
  const config = getSupabaseConfig();
  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "dailyforge-lite/0.1" },
    },
  });
}
