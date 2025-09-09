// netlify/functions/intent-design.js
const fetch = require('node-fetch');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ success:false, error:'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }) };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/design-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    try {
      const data = text ? JSON.parse(text) : {};
      return { statusCode: resp.status, headers: cors, body: JSON.stringify(data) };
    } catch {
      return { statusCode: resp.status, headers: cors, body: text };
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success:false, error: e.message || String(e) }) };
  }
};
