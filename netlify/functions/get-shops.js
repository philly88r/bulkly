const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // Auth
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized - No token' }) };
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized - Invalid token' }) };
    }
    const userId = decoded.sub || decoded.id;

    // Supabase
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Get encrypted Printify API key
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printify_api_key_encrypted')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.printify_api_key_encrypted) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Printify API key not found for user.' }) };
    }

    // Simple XOR decrypt with JWT_SECRET (matches other functions)
    function simpleDecrypt(encryptedBase64, key) {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyLength = key.length;
      const result = [];
      for (let i = 0; i < encryptedBytes.length; i++) {
        result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
      }
      return Buffer.from(result).toString('utf8');
    }

    const printifyApiToken = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
    if (!printifyApiToken) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Failed to decrypt Printify API key.' }) };
    }

    // Fetch shops from Printify
    const shopsRes = await fetch('https://api.printify.com/v1/shops.json', {
      headers: { 'Authorization': `Bearer ${printifyApiToken}` }
    });
    const rawText = await shopsRes.text();
    let shops = [];
    try { shops = rawText ? JSON.parse(rawText) : []; } catch { shops = []; }

    if (!shopsRes.ok) {
      return { statusCode: shopsRes.status, headers, body: JSON.stringify({ error: 'Failed to fetch shops', details: shops || rawText }) };
    }

    // Normalize minimal fields
    const normalized = Array.isArray(shops) ? shops.map(s => ({
      id: s.id,
      title: s.title || s.name || `Shop ${s.id}`,
      sales_channel: s.sales_channel || s.channel || null
    })) : [];

    return { statusCode: 200, headers, body: JSON.stringify({ shops: normalized }) };
  } catch (err) {
    console.error('get-shops error:', err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Internal Server Error', details: err.message }) };
  }
};
