// netlify/functions/printful-refresh-token.js
// Refreshes expired Printful OAuth tokens

const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const encrypt = (text, key) => {
  const res = [];
  for (let i = 0; i < text.length; i++) res.push(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return Buffer.from(res).toString('base64');
};

const decrypt = (encryptedText, key) => {
  const buf = Buffer.from(encryptedText, 'base64');
  const res = [];
  for (let i = 0; i < buf.length; i++) res.push(buf[i] ^ key.charCodeAt(i % key.length));
  return Buffer.from(res).toString('utf8');
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };

  try {
    // Verify JWT and get user ID
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Missing or invalid authorization header' }) };
    }

    const token = authHeader.replace('Bearer ', '');
    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.sub || decoded.id;
    } catch (err) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Invalid JWT token' }) };
    }

    if (!userId) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'User ID not found in token' }) };
    }

    // Get user's refresh token from database
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('printful_refresh_token_encrypted')
      .eq('id', userId)
      .single();

    if (fetchError || !user?.printful_refresh_token_encrypted) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'No refresh token found. Please re-authorize with Printful.' }) };
    }

    // Decrypt refresh token
    const refreshToken = decrypt(user.printful_refresh_token_encrypted, process.env.JWT_SECRET);

    // Exchange refresh token for new access token
    const clientId = process.env.PRINTFUL_CLIENT_ID;
    const clientSecret = process.env.PRINTFUL_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Missing Printful OAuth credentials' }) };
    }

    const tokenUrl = 'https://www.printful.com/oauth/token';
    const form = new URLSearchParams();
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refreshToken);

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      return { 
        statusCode: tokenRes.status, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          error: 'Token refresh failed', 
          details: tokenJson,
          requiresReauth: tokenRes.status === 400 || tokenRes.status === 401
        }) 
      };
    }

    const newAccessToken = tokenJson.access_token;
    const newRefreshToken = tokenJson.refresh_token || refreshToken; // Some providers don't return new refresh token
    const expiresAtUnix = tokenJson.expires_at ? parseInt(tokenJson.expires_at, 10) : null;
    const expiresAt = expiresAtUnix ? new Date(expiresAtUnix * 1000).toISOString() : null;

    // Encrypt and store new tokens
    const encAccess = encrypt(newAccessToken, process.env.JWT_SECRET);
    const encRefresh = encrypt(newRefreshToken, process.env.JWT_SECRET);

    const { error: updateError } = await supabase
      .from('users')
      .update({
        printful_access_token_encrypted: encAccess,
        printful_refresh_token_encrypted: encRefresh,
        printful_token_expires_at: expiresAt
      })
      .eq('id', userId);

    if (updateError) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Failed to save refreshed tokens', details: updateError.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Token refreshed successfully',
        expires_at: expiresAt
      })
    };

  } catch (err) {
    console.error('printful-refresh-token error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Internal Server Error' }) };
  }
};
