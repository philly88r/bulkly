// /.netlify/functions/db-info
// Exposes database helper details safely. Optionally attempts a connection with ?connect=true

const { createClient, getDatabaseUrl } = require('./_db');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const wantConnect = String((event.queryStringParameters || {}).connect || '').toLowerCase() === 'true';

  try {
    // Determine source var in priority order
    const dbSourceVar = process.env.SUPABASE_DB_URL
      ? 'SUPABASE_DB_URL'
      : process.env.DATABASE_URL
        ? 'DATABASE_URL'
        : process.env.NETLIFY_DATABASE_URL
          ? 'NETLIFY_DATABASE_URL'
          : process.env.NETLIFY_DATABASE_URL_UNPOOLED
            ? 'NETLIFY_DATABASE_URL_UNPOOLED'
            : null;

    let url; let info = null; let connectOk = false; let error = null;
    try {
      url = getDatabaseUrl();
      info = parseDbInfo(url);
    } catch (e) {
      error = e.message || String(e);
    }

    if (wantConnect && url && !error) {
      try {
        const client = createClient();
        await client.connect();
        await client.end();
        connectOk = true;
      } catch (e) {
        error = e.message || String(e);
      }
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        success: !error,
        sourceVar: dbSourceVar,
        info,
        connectTried: wantConnect,
        connectOk,
        error
      })
    };
  } catch (err) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
  }
};

function parseDbInfo(url) {
  try {
    if (!url) return null;
    const u = new URL(url);
    const params = new URLSearchParams(u.search || '');
    const sslmode = params.get('sslmode') || null;
    const database = (u.pathname || '').replace(/^\//, '') || null;
    return {
      scheme: (u.protocol || '').replace(':', ''),
      host: u.hostname || null,
      port: u.port || null,
      database,
      sslmode
    };
  } catch {
    return null;
  }
}
