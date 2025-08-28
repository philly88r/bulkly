// Shared database helper for Netlify Functions
// Centralizes env var resolution and connection creation.

const { Client } = require('pg');

function getDatabaseUrl() {
  const url =
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;

  if (!url) {
    throw new Error('Database configuration missing. Set SUPABASE_DB_URL or DATABASE_URL or NETLIFY_DATABASE_URL(_UNPOOLED).');
  }
  return ensureSslMode(url);
}

function ensureSslMode(url) {
  // If sslmode is not specified, append sslmode=require for Neon/managed Postgres
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
