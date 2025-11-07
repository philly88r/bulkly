// netlify/functions/upload-composed-file.js
// Uploads a composed PNG (provided as data URL) to Printful File Library via OAuth
// Returns a public URL that can be used in mockup tasks

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Unauthorized - No token' }) };
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');

    // Verify JWT
    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.sub || decoded.id;
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Unauthorized - Invalid token' }) };
    }

    // Parse body
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const { filename = 'composed.png', data_url } = body || {};
    if (!data_url || typeof data_url !== 'string' || !data_url.startsWith('data:')) {
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'Invalid data_url' }) };
    }

    // Extract mime and base64
    const match = data_url.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) {
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'Unsupported data URL format' }) };
    }
    const mime = match[1] || 'image/png';
    const b64 = match[2];
    const buffer = Buffer.from(b64, 'base64');

    // Get Printful OAuth token from Supabase
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printful_access_token_encrypted, printful_refresh_token_encrypted, printful_token_expires_at')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.printful_access_token_encrypted) {
      return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Printful OAuth not connected for this user.' }) };
    }

    function simpleDecrypt(encryptedBase64, key) {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyLength = key.length;
      const result = [];
      for (let i = 0; i < encryptedBytes.length; i++) {
        result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
      }
      return Buffer.from(result).toString('utf8');
    }

    let accessToken = simpleDecrypt(user.printful_access_token_encrypted, process.env.JWT_SECRET);
    const refreshToken = user.printful_refresh_token_encrypted ? simpleDecrypt(user.printful_refresh_token_encrypted, process.env.JWT_SECRET) : null;
    const expiresAtIso = user.printful_token_expires_at || null;

    async function refreshAccessTokenIfNeeded(reason = '') {
      try {
        if (!refreshToken) return false;
        if (reason === 'preemptive') {
          if (!expiresAtIso) return false;
          const now = Date.now();
          const expiresMs = Date.parse(expiresAtIso);
          if (!expiresMs || (expiresMs - now) > 60_000) return false;
        }
        const form = new URLSearchParams();
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', refreshToken);
        form.set('client_id', process.env.PRINTFUL_CLIENT_ID);
        form.set('client_secret', process.env.PRINTFUL_CLIENT_SECRET);
        const tokenRes = await fetch('https://www.printful.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
        const tokenJson = await tokenRes.json().catch(()=>({}));
        if (!tokenRes.ok || !tokenJson?.access_token) return false;
        accessToken = tokenJson.access_token;
        const newRefresh = tokenJson.refresh_token || refreshToken;
        const expiresAtUnix = tokenJson.expires_at ? parseInt(tokenJson.expires_at, 10) : null;
        const newExpiresIso = expiresAtUnix ? new Date(expiresAtUnix * 1000).toISOString() : null;
        const enc = (val) => Buffer.from(Buffer.from(val, 'utf8').map((b, i) => b ^ process.env.JWT_SECRET.charCodeAt(i % process.env.JWT_SECRET.length))).toString('base64');
        await supabase
          .from('users')
          .update({
            printful_access_token_encrypted: enc(accessToken),
            printful_refresh_token_encrypted: newRefresh ? enc(newRefresh) : user.printful_refresh_token_encrypted,
            printful_token_expires_at: newExpiresIso || user.printful_token_expires_at
          })
          .eq('id', userId);
        return true;
      } catch {
        return false;
      }
    }

    await refreshAccessTokenIfNeeded('preemptive');

    // Build multipart form using native FormData/Blob (Node 18+ / undici)
    const fd = new FormData();
    const blob = new Blob([buffer], { type: mime });
    fd.append('file', blob, filename);

    // POST to Printful File Library
    const pfRes = await fetch('https://api.printful.com/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`
        // Note: do NOT set Content-Type; fetch sets proper multipart boundary
      },
      body: fd
    });

    const raw = await pfRes.text();
    let json; try { json = raw ? JSON.parse(raw) : {}; } catch { json = {}; }

    if (!pfRes.ok) {
      return { statusCode: pfRes.status, headers, body: JSON.stringify({ success:false, error:'Printful upload failed', details: json || raw }) };
    }

    // Printful response: { result: { id, type, hash, url, ... }, ... }
    const fileObj = json?.result || json?.data || json;
    const url = fileObj?.url || fileObj?.thumbnail_url || null;

    if (!url) {
      return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Upload succeeded but URL missing', details: json }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success:true, url, id: fileObj?.id || null, details: fileObj }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Internal Server Error', details: err.message }) };
  }
};
