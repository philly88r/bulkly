// Shared database helper for Netlify Functions
// Centralizes env var resolution and connection creation.

const { Client } = require('pg');

function isPostgresUrl(u) {
  return typeof u === 'string' && /^postgres(ql)?:\/\//i.test(u);
}

function validateUrlOrThrow(u) {
  if (!u) {
    throw new Error('Database configuration missing. Set SUPABASE_DB_URL or DATABASE_URL or NETLIFY_DATABASE_URL(_UNPOOLED).');
  }
  // Common mistake: providing Supabase REST URL instead of Postgres URL
  if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
    throw new Error('Invalid DB URL: looks like an HTTP URL. Use your Supabase Postgres connection string (postgres://...) as SUPABASE_DB_URL.');
  }
  if (!isPostgresUrl(u)) {
    throw new Error('Invalid DB URL: must start with postgres:// or postgresql://');
  }
}

function getDatabaseUrl() {
  const url =
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;

  validateUrlOrThrow(url);
  return ensureSslMode(url);
}

function ensureSslMode(url) {
  // Only handle postgres URLs
  if (!isPostgresUrl(url)) return url;
  // If sslmode is not specified, append sslmode=require for managed Postgres
  if (/sslmode=/.test(url)) return url;
  const hasQuery = url.includes('?');
  return url + (hasQuery ? '&' : '?') + 'sslmode=require';
}

function createClient() {
  const connectionString = getDatabaseUrl();
  // Prefer sslmode in connection string; pg will honor it. No explicit ssl option needed.
  return new Client({ connectionString });
}

module.exports = { getDatabaseUrl, createClient };
