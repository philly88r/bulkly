// netlify/functions/printful-proxy.js
// Generic proxy to Printful API. Forwards requests to https://api.printful.com
// Uses the requesting user's stored Printful API key from Supabase (encrypted) and JWT for auth.

const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (!['GET','POST','PUT','DELETE'].includes(event.httpMethod)) {
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

    // Get Printful OAuth token from Supabase (public app, OAuth-only)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printful_access_token_encrypted, printful_refresh_token_encrypted, printful_token_expires_at')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.printful_access_token_encrypted) {
      return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Printful OAuth not connected for this user. Connect via Dashboard → Settings.' }) };
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

    let authToken = user.printful_access_token_encrypted ? simpleDecrypt(user.printful_access_token_encrypted, process.env.JWT_SECRET) : null;
    const refreshToken = user.printful_refresh_token_encrypted ? simpleDecrypt(user.printful_refresh_token_encrypted, process.env.JWT_SECRET) : null;
    const expiresAtIso = user.printful_token_expires_at || null;
    if (!authToken) {
      return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Failed to decrypt Printful OAuth token.' }) };
    }

    async function refreshAccessTokenIfNeeded(reason = '') {
      try {
        // If we don't have a refresh token, we cannot refresh
        if (!refreshToken) return false;
        // If reason is 'preemptive', check expiry; otherwise (e.g., 401), force refresh
        if (reason === 'preemptive') {
          if (!expiresAtIso) return false;
          const now = Date.now();
          const expiresMs = Date.parse(expiresAtIso);
          if (!expiresMs || (expiresMs - now) > 60_000) return false; // more than 60s left
        }
        // Perform OAuth refresh
        const tokenRes = await fetch('https://www.printful.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: process.env.PRINTFUL_CLIENT_ID,
            client_secret: process.env.PRINTFUL_CLIENT_SECRET
          })
        });
        const tokenJson = await tokenRes.json().catch(()=>({}));
        if (!tokenRes.ok || !tokenJson?.access_token) return false;
        // Update local values
        authToken = tokenJson.access_token;
        const newRefresh = tokenJson.refresh_token || refreshToken;
        const expiresAtUnix = tokenJson.expires_at ? parseInt(tokenJson.expires_at, 10) : null;
        const newExpiresIso = expiresAtUnix ? new Date(expiresAtUnix * 1000).toISOString() : null;
        // Persist encrypted in DB
        const enc = (val) => Buffer.from(Buffer.from(val, 'utf8').map((b, i) => b ^ process.env.JWT_SECRET.charCodeAt(i % process.env.JWT_SECRET.length))).toString('base64');
        await supabase
          .from('users')
          .update({
            printful_access_token_encrypted: enc(authToken),
            printful_refresh_token_encrypted: newRefresh ? enc(newRefresh) : user.printful_refresh_token_encrypted,
            printful_token_expires_at: newExpiresIso || user.printful_token_expires_at
          })
          .eq('id', userId);
        return true;
      } catch {
        return false;
      }
    }

    // Parse body
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const endpoint = body.endpoint || (event.queryStringParameters && event.queryStringParameters.endpoint);
    const method = body.method || event.httpMethod;
    const forwardBody = body.body || null;

    if (!endpoint || typeof endpoint !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'Missing endpoint' }) };
    }

    const base = 'https://api.printful.com';
    const url = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;

    // Preemptive refresh if near expiry
    await refreshAccessTokenIfNeeded('preemptive');

    async function doRequest(currentToken) {
      return fetch(url, {
        method,
        headers: {
          // Per current Printful docs, OAuth 2.0 replaces HTTP Basic. Use Bearer with either OAuth access token or private token
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : (forwardBody ? JSON.stringify(forwardBody) : undefined)
      });
    }

    let pfRes = await doRequest(authToken);

    const text = await pfRes.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (pfRes.status === 401) {
      // Try one refresh then retry the request
      const refreshed = await refreshAccessTokenIfNeeded('forced');
      if (refreshed) {
        pfRes = await doRequest(authToken);
        const retryText = await pfRes.text();
        let retryData = null; try { retryData = retryText ? JSON.parse(retryText) : null; } catch { retryData = retryText; }
        if (!pfRes.ok) {
          return { statusCode: pfRes.status, headers, body: JSON.stringify({ success:false, error:'Printful API error after refresh', details: retryData }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success:true, data: retryData }) };
      }
    }

    if (!pfRes.ok) {
      return { statusCode: pfRes.status, headers, body: JSON.stringify({ success:false, error:'Printful API error', details: data }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success:true, data }) };
  } catch (err) {
    console.error('printful-proxy error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Internal Server Error', details: err.message }) };
  }
};
