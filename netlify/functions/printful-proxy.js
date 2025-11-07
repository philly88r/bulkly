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

  console.log('[printful-proxy] Request received:', {
    method: event.httpMethod,
    body: event.body ? JSON.parse(event.body) : null,
    headers: event.headers
  });

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
      console.log('[printful-proxy] JWT verified for user:', userId);
    } catch (e) {
      console.log('[printful-proxy] JWT verification failed:', e.message);
      return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Unauthorized - Invalid token' }) };
    }

    // Get Printful OAuth token from Supabase (public app, OAuth-only)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printful_access_token_encrypted, printful_refresh_token_encrypted, printful_token_expires_at')
      .eq('id', userId)
      .single();

    console.log('[printful-proxy] Supabase user lookup:', { 
      userId, 
      hasUser: !!user, 
      hasToken: !!(user?.printful_access_token_encrypted),
      userError: userError?.message 
    });

    if (userError || !user || !user.printful_access_token_encrypted) {
      console.log('[printful-proxy] No Printful OAuth token found for user');
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
        if (!refreshToken) {
          console.log('[printful-proxy] No refresh token available');
          return false;
        }

        // If reason is 'preemptive', check expiry; otherwise (e.g., 401), force refresh
        if (reason === 'preemptive') {
          if (!expiresAtIso) {
            console.log('[printful-proxy] No expiry info, skipping preemptive refresh');
            return false;
          }
          const now = Date.now();
          const expiresMs = Date.parse(expiresAtIso);
          if (!expiresMs || (expiresMs - now) > 60_000) {
            console.log('[printful-proxy] Token still valid for >60s, skipping refresh');
            return false; // more than 60s left
          }
        }

        console.log(`[printful-proxy] Refreshing OAuth token (reason: ${reason})`);

        // Perform OAuth refresh using form data (per Printful docs) with timeout
        const form = new URLSearchParams();
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', refreshToken);
        form.set('client_id', process.env.PRINTFUL_CLIENT_ID);
        form.set('client_secret', process.env.PRINTFUL_CLIENT_SECRET);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        try {
          const tokenRes = await fetch('https://www.printful.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          const tokenJson = await tokenRes.json().catch(()=>({}));
          if (!tokenRes.ok || !tokenJson?.access_token) {
            console.warn('[printful-proxy] OAuth refresh failed:', tokenRes.status, tokenJson);
            return false;
          }

          console.log('[printful-proxy] OAuth token refreshed successfully');

          // Update local values
          authToken = tokenJson.access_token;
          const newRefresh = tokenJson.refresh_token || refreshToken;
          const expiresAtUnix = tokenJson.expires_at ? parseInt(tokenJson.expires_at, 10) : null;
          const newExpiresIso = expiresAtUnix ? new Date(expiresAtUnix * 1000).toISOString() : null;

          // Persist encrypted in DB with timeout
          const enc = (val) => Buffer.from(Buffer.from(val, 'utf8').map((b, i) => b ^ process.env.JWT_SECRET.charCodeAt(i % process.env.JWT_SECRET.length))).toString('base64');

          // Use a timeout for Supabase operation to prevent hanging
          const updatePromise = supabase
            .from('users')
            .update({
              printful_access_token_encrypted: enc(authToken),
              printful_refresh_token_encrypted: newRefresh ? enc(newRefresh) : user.printful_refresh_token_encrypted,
              printful_token_expires_at: newExpiresIso || user.printful_token_expires_at
            })
            .eq('id', userId);

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Supabase update timeout')), 10000)
          );

          await Promise.race([updatePromise, timeoutPromise]);
          console.log('[printful-proxy] Token persisted to database');

          return true;
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError.name === 'AbortError') {
            console.warn('[printful-proxy] OAuth refresh timed out');
          } else {
            console.warn('[printful-proxy] OAuth refresh error:', fetchError.message);
          }
          return false;
        }
      } catch (error) {
        console.error('[printful-proxy] Refresh function error:', error.message);
        return false;
      }
    }

    // Parse body
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const endpoint = body.endpoint || (event.queryStringParameters && event.queryStringParameters.endpoint);
    const method = body.method || event.httpMethod;
    const forwardBody = body.body || null;
    const extraHeaders = (body.headers && typeof body.headers === 'object') ? body.headers : {};

    if (!endpoint || typeof endpoint !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'Missing endpoint' }) };
    }

    const base = 'https://api.printful.com';
    let url = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;

    // Ensure v2 endpoints are properly formatted
    if (endpoint.startsWith('/v2/') && !endpoint.startsWith('http')) {
      url = `${base}${endpoint}`;
      console.log('[printful-proxy] Using v2 API endpoint:', url);
    }

    // Remove selling_region_name parameter for OAuth compatibility (legacy)
    if (url.includes('selling_region_name')) {
      const urlObj = new URL(url);
      urlObj.searchParams.delete('selling_region_name');
      url = urlObj.toString();
      console.log('[printful-proxy] Removed selling_region_name parameter from URL');
    }

    // Log rate limit info for debugging
    console.log('[printful-proxy] API call to:', url.replace(base, ''));

    console.log('[printful-proxy] Making request to:', { url, method, extraHeaders, hasBody: !!forwardBody });

    // Skip preemptive refresh for now to avoid delays - only refresh on 401
    // await refreshAccessTokenIfNeeded('preemptive');

    async function doRequest(currentToken) {
      // Merge headers: OAuth Authorization + JSON + any extra headers provided by client
      const mergedHeaders = {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json',
        ...extraHeaders
      };
      console.log('[printful-proxy] Request headers (redacted):', { ...mergedHeaders, Authorization: 'Bearer [REDACTED]' });

      // Add timeout to Printful API requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      try {
        const response = await fetch(url, {
          method,
          headers: mergedHeaders,
          body: method === 'GET' || method === 'DELETE' ? undefined : (forwardBody ? JSON.stringify(forwardBody) : undefined),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          console.error('[printful-proxy] Request to Printful timed out after 30s');
          throw new Error('Request to Printful API timed out');
        }
        throw error;
      }
    }

    let pfRes;
    try {
      pfRes = await doRequest(authToken);
    } catch (requestError) {
      console.error('[printful-proxy] Initial request failed:', requestError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Request to Printful failed', details: requestError.message }) };
    }

    const text = await pfRes.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    // Extract and log rate limit headers
    const rateLimitHeaders = {
      limit: pfRes.headers.get('x-ratelimit-limit') || pfRes.headers.get('X-RateLimit-Limit'),
      remaining: pfRes.headers.get('x-ratelimit-remaining') || pfRes.headers.get('X-RateLimit-Remaining'),
      reset: pfRes.headers.get('x-ratelimit-reset') || pfRes.headers.get('X-RateLimit-Reset'),
      policy: pfRes.headers.get('x-ratelimit-policy')
    };

    console.log('[printful-proxy] Printful API response:', {
      status: pfRes.status,
      statusText: pfRes.statusText,
      dataType: typeof data,
      dataPreview: data ? JSON.stringify(data).slice(0, 200) : null,
      rateLimit: rateLimitHeaders
    });

    if (pfRes.status === 401) {
      console.log('[printful-proxy] Got 401, attempting token refresh');
      // Try one refresh then retry the request
      const refreshed = await refreshAccessTokenIfNeeded('forced');
      if (refreshed) {
        console.log('[printful-proxy] Token refreshed, retrying request');
        try {
          pfRes = await doRequest(authToken);
          const retryText = await pfRes.text();
          let retryData = null; try { retryData = retryText ? JSON.parse(retryText) : null; } catch { retryData = retryText; }
          console.log('[printful-proxy] Retry response:', { status: pfRes.status, hasData: !!retryData });
          if (!pfRes.ok) {
            return { statusCode: pfRes.status, headers, body: JSON.stringify({ success:false, error:'Printful API error after refresh', details: retryData }) };
          }
          // Include rate limit info in successful retry response
          const retryRateLimit = {
            limit: pfRes.headers.get('x-ratelimit-limit'),
            remaining: pfRes.headers.get('x-ratelimit-remaining'),
            reset: pfRes.headers.get('x-ratelimit-reset')
          };
          return { statusCode: 200, headers, body: JSON.stringify({ success:true, data: retryData, rateLimit: retryRateLimit }) };
        } catch (retryError) {
          console.error('[printful-proxy] Retry request failed:', retryError.message);
          return { statusCode: 500, headers, body: JSON.stringify({ success:false, error:'Retry request failed', details: retryError.message }) };
        }
      } else {
        console.log('[printful-proxy] Token refresh failed');
        return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Token refresh failed', requiresReauth: true }) };
      }
    }

    if (!pfRes.ok) {
      console.log('[printful-proxy] API error:', { status: pfRes.status, data });
      
      // Handle rate limiting (429) with retry-after header
      if (pfRes.status === 429) {
        const retryAfter = pfRes.headers.get('retry-after') || '60';
        return { 
          statusCode: 429, 
          headers: { ...headers, 'Retry-After': retryAfter }, 
          body: JSON.stringify({ 
            success: false, 
            error: 'Rate limit exceeded', 
            retryAfter: parseInt(retryAfter, 10),
            details: data 
          }) 
        };
      }
      
      // Handle insufficient scopes (403)
      if (pfRes.status === 403) {
        return { 
          statusCode: 403, 
          headers, 
          body: JSON.stringify({ 
            success: false, 
            error: 'Insufficient permissions. Please re-authorize with Printful to grant required scopes.', 
            requiresReauth: true,
            details: data 
          }) 
        };
      }
      
      return { statusCode: pfRes.status, headers, body: JSON.stringify({ success:false, error:'Printful API error', details: data }) };
    }

    // Include rate limit info in successful response
    const finalRateLimit = {
      limit: pfRes.headers.get('x-ratelimit-limit'),
      remaining: pfRes.headers.get('x-ratelimit-remaining'),
      reset: pfRes.headers.get('x-ratelimit-reset'),
      policy: pfRes.headers.get('x-ratelimit-policy')
    };

    console.log('[printful-proxy] Success response with rate limit info:', finalRateLimit);
    return { statusCode: 200, headers, body: JSON.stringify({ success:true, data, rateLimit: finalRateLimit }) };
  } catch (err) {
    console.error('printful-proxy error:', err);

    // Provide more specific error messages
    let errorMessage = 'Internal Server Error';
    if (err.message?.includes('timeout')) {
      errorMessage = 'Request timed out';
    } else if (err.message?.includes('network')) {
      errorMessage = 'Network error';
    } else if (err.message?.includes('ECONNRESET')) {
      errorMessage = 'Connection reset by Printful';
    } else if (err.message?.includes('ENOTFOUND')) {
      errorMessage = 'Cannot reach Printful API';
    }

    return { statusCode: 500, headers, body: JSON.stringify({ success:false, error: errorMessage, details: err.message }) };
  }
};
