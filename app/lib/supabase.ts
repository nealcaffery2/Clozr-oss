// The Supabase client, or null when this build has no project to talk to
// (demo mode). Both values are NEXT_PUBLIC_*, so the bundler inlines them into
// the JavaScript every visitor downloads: the publishable key is designed to be
// public and the security boundary is row-level security in Postgres. What is
// genuinely secret (the service role key, signing secrets) lives only in the
// edge functions and the database, never here.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import { guardedFetch } from './read-only';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
/** For the few calls that need raw fetch (a streamed edge-function response). */
export const SUPABASE_PUBLISHABLE_KEY = publishableKey;

// Every request goes through guardedFetch, which refuses writes while an admin
// is previewing a teammate read-only (lib/read-only.ts). Otherwise it is fetch.
export const supabase = SUPABASE_URL && publishableKey
  ? createClient<Database>(SUPABASE_URL, publishableKey, { global: { fetch: guardedFetch } })
  : null;
