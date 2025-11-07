// netlify/functions/printful-oauth-callback.js
// Handles redirect from Printful OAuth, exchanges code for tokens, stores them for the user.

const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const encrypt = (text, key) => {
  const res = [];
  for (let i = 0; i < text.length; i++) res.push(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return Buffer.from(res).toString('base64');
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };

  console.log('[printful-oauth-callback] Request received:', {
    method: event.httpMethod,
    queryParams: event.queryStringParameters,
    headers: event.headers
  });

  try {
    const { code, state } = event.queryStringParameters || {};
    console.log('[printful-oauth-callback] Extracted params:', { code: code?.slice(0, 10) + '...', state: state?.slice(0, 20) + '...' });
    
    if (!code) {
      console.log('[printful-oauth-callback] Missing authorization code');
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'Missing code' }) };
    }

    // Resolve userId from state or Authorization header
    let userId = null;
    console.log('[printful-oauth-callback] Resolving user ID...');
    
    // 1) Try verify state with server secret
    try {
      if (state) {
        const verified = jwt.verify(state, process.env.JWT_SECRET);
        userId = verified.sub || verified.id || null;
        console.log('[printful-oauth-callback] User ID from verified state:', userId);
      }
    } catch (e) {
      console.log('[printful-oauth-callback] State verification failed:', e.message);
    }
    
    // 2) If still missing, try decoding state without verification (best-effort)
    if (!userId && state) {
      try {
        const decodedLoose = jwt.decode(state) || {};
        userId = decodedLoose.sub || decodedLoose.id || null;
        console.log('[printful-oauth-callback] User ID from decoded state:', userId);
      } catch (e) {
        console.log('[printful-oauth-callback] State decode failed:', e.message);
      }
    }
    
    // 3) If still missing, try Authorization header
    if (!userId) {
      try {
        const auth = event.headers.authorization || event.headers.Authorization || '';
        if (/^Bearer\s+/i.test(auth)) {
          const bearer = auth.replace(/^Bearer\s+/i, '');
          const verifiedAuth = jwt.verify(bearer, process.env.JWT_SECRET);
          userId = verifiedAuth.sub || verifiedAuth.id || null;
          console.log('[printful-oauth-callback] User ID from auth header:', userId);
        }
      } catch (e) {
        console.log('[printful-oauth-callback] Auth header verification failed:', e.message);
      }
    }

    const clientId = process.env.PRINTFUL_CLIENT_ID;
    const clientSecret = process.env.PRINTFUL_CLIENT_SECRET;
    console.log('[printful-oauth-callback] OAuth credentials check:', { 
      hasClientId: !!clientId, 
      hasClientSecret: !!clientSecret 
    });
    
    if (!clientId || !clientSecret) {
      console.log('[printful-oauth-callback] Missing OAuth credentials');
      return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Missing Printful OAuth env vars' }) };
    }

    // Exchange code for tokens. Printful docs: use your app installation token endpoint.
    console.log('[printful-oauth-callback] Starting token exchange...');
    const tokenUrl = 'https://www.printful.com/oauth/token';
    const form = new URLSearchParams();
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    form.set('grant_type', 'authorization_code');
    form.set('code', code);

    console.log('[printful-oauth-callback] Making token request to:', tokenUrl);
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    console.log('[printful-oauth-callback] Token response status:', tokenRes.status);
    const tokenJson = await tokenRes.json().catch(() => ({}));
    console.log('[printful-oauth-callback] Token response data:', { 
      hasAccessToken: !!tokenJson.access_token,
      hasRefreshToken: !!tokenJson.refresh_token,
      expiresAt: tokenJson.expires_at 
    });
    
    if (!tokenRes.ok) {
      console.log('[printful-oauth-callback] Token exchange failed:', tokenJson);
      return { statusCode: tokenRes.status, headers, body: JSON.stringify({ success:false, error:'Token exchange failed', details: tokenJson }) };
    }

    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;
    // Per docs, expires_at is a unix timestamp string
    const expiresAtUnix = tokenJson.expires_at ? parseInt(tokenJson.expires_at, 10) : null;
    const expiresAt = expiresAtUnix ? new Date(expiresAtUnix * 1000).toISOString() : null;

    console.log('[printful-oauth-callback] Processing tokens:', {
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      expiresAt,
      userId
    });

    if (!userId) {
      console.log('[printful-oauth-callback] No user ID found - cannot save tokens');
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'Missing user context for OAuth token save' }) };
    }

    console.log('[printful-oauth-callback] Encrypting and saving tokens to database...');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const encAccess = accessToken ? encrypt(accessToken, process.env.JWT_SECRET) : null;
    const encRefresh = refreshToken ? encrypt(refreshToken, process.env.JWT_SECRET) : null;

    const { error } = await supabase
      .from('users')
      .update({
        printful_access_token_encrypted: encAccess,
        printful_refresh_token_encrypted: encRefresh,
        printful_token_expires_at: expiresAt
      })
      .eq('id', userId);

    if (error) {
      console.log('[printful-oauth-callback] Database save failed:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Failed to save tokens', details: error.message }) };
    }

    console.log('[printful-oauth-callback] Tokens saved successfully!');

    // Redirect back to settings with success
    return {
      statusCode: 302,
      headers: { ...headers, Location: '/dashboard.html#settings?printful=connected' },
      body: ''
    };
  } catch (err) {
    console.error('printful-oauth-callback error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Internal Server Error' }) };
  }
};
