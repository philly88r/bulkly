// /.netlify/functions/health.js
// Simple health check for environment and connectivity
const { createClient, getDatabaseUrl } = require('./_db');

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

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
  try {
    const shallow = String((event?.queryStringParameters || {}).shallow || '').toLowerCase() === 'true';

    // Check DB URL present and valid
    let dbUrlOk = false;
    let dbConnectOk = false;
    let dbErr = null;
    let dbSourceVar = null;
    let dbInfo = null;
    try {
      dbSourceVar = process.env.SUPABASE_DB_URL
        ? 'SUPABASE_DB_URL'
        : process.env.DATABASE_URL
          ? 'DATABASE_URL'
          : process.env.NETLIFY_DATABASE_URL
            ? 'NETLIFY_DATABASE_URL'
            : process.env.NETLIFY_DATABASE_URL_UNPOOLED
              ? 'NETLIFY_DATABASE_URL_UNPOOLED'
              : null;

      const url = getDatabaseUrl();
      dbUrlOk = !!url;
      dbInfo = parseDbInfo(url);
      if (!shallow) {
        // Attempt lightweight connect
        const client = createClient();
        await client.connect();
        await client.end();
        dbConnectOk = true;
      }
    } catch (e) {
      dbErr = e.message || String(e);
    }

    // Check Gemini and FAL keys presence
    const geminiOk = !!process.env.GEMINI_API_KEY;
    const falOk = !!process.env.FAL_KEY;

    // Never hard-fail: always return 200 with details for easy diagnostics
    const status = dbUrlOk && (shallow ? true : dbConnectOk);
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: status,
        db: { urlPresent: dbUrlOk, connect: dbConnectOk, error: dbErr, shallow, sourceVar: dbSourceVar, info: dbInfo },
        gemini: { present: geminiOk },
        fal: { present: falOk },
      })
    };
  } catch (err) {
    // Still never throw to caller
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
