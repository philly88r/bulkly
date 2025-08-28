// Shared Supabase client for Netlify (Node) Functions
// Uses service role by default for server-side operations.

const { createClient } = require('@supabase/supabase-js');

function getSupabase(useServiceRole = true) {
  const url = process.env.SUPABASE_URL;
  const key = useServiceRole
    ? process.env.SUPABASE_SERVICE_ROLE_KEY
    : process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_*KEY environment variables');
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

module.exports = { getSupabase };
