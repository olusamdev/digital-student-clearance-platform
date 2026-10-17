import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const envReady = Boolean(url && anonKey && !anonKey.includes('replace_with_'));

export const supabase = createClient(
  url || 'https://example.supabase.co',
  anonKey || 'missing-public-anon-key',
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  },
);
