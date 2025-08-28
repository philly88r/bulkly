// printify-proxy.js
// Netlify serverless function that proxies requests to the Printify API.
// Reads PRINTIFY_API_KEY from Netlify environment variables.

const PRINTIFY_API_BASE = 'https://api.printify.com/v1';
const API_KEY = process.env.PRINTIFY_API_KEY;          // set in Netlify → Site Settings → Environment

exports.handler = async (event) => {
  /* ── CORS pre-flight ── */
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers, body: '' };

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };

  // Get the user's API key from the database
  const authHeader = event.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Authentication required' }) };
  }

  const token = authHeader.split(' ')[1];
  
  // Import the get-api-key function
  const jwt = require('jsonwebtoken');
  const { createClient } = require('@supabase/supabase-js');
  
  // Helper function for XOR decryption (matches update-api-key.js encryption)
  function simpleDecrypt(encryptedBase64, key) {
    try {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyLength = key.length;
      const result = [];
      
      for (let i = 0; i < encryptedBytes.length; i++) {
        const byte = encryptedBytes[i];
        const keyCharCode = key.charCodeAt(i % keyLength);
        result.push(byte ^ keyCharCode);
      }
      
      return Buffer.from(result).toString('utf8');
    } catch (error) {
      console.error('Decryption error:', error);
      return null;
    }
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.sub || decoded.id;

    // Fetch the user's encrypted API key
    const { data: user, error } = await supabase
      .from('users')
      .select('printify_api_key_encrypted')
      .eq('id', userId)
      .single();

    if (error || !user || !user.printify_api_key_encrypted) {
      console.error('Error fetching user API key:', error);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'Printify API key not found' })
      };
    }

    // Decrypt the API key
    const apiKey = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
    
    // Validate the decrypted API key
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
      console.error('Invalid decrypted API key:', { length: apiKey?.length, sample: apiKey?.substring(0, 10) });
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'Invalid API key format. Please re-enter your API key in dashboard settings.' })
      };
    }

    try {
      /* ── Parse request from frontend ── */
      console.log('[proxy] Incoming event body:', event.body);
      const { endpoint, method = 'GET', body } = JSON.parse(event.body || '{}');
      if (!endpoint)
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Missing endpoint' }) };

      /* ── Forward to Printify ── */
      const requestOptions = {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Printify-POD-Manager/1.0'
        }
      };
      let outgoingBody = body;
      // Normalize string body -> object for inspection
      if (typeof outgoingBody === 'string') {
        try { outgoingBody = JSON.parse(outgoingBody); } catch { /* leave as string */ }
      }

      // If publishing, ensure required boolean flags are sent
      if (['POST', 'PUT'].includes(method) && typeof endpoint === 'string' && /\/publish\.json$/.test(endpoint)) {
        const needsCoercion = (obj) => !obj || typeof obj !== 'object' || [
          ['title'], ['description'], ['images'], ['variants'], ['tags']
        ].some(([k]) => typeof obj[k] !== 'boolean');

        if (needsCoercion(outgoingBody)) {
          console.log('[proxy] Coercing publish payload to booleans');
          outgoingBody = {
            title: true,
            description: true,
            images: true,
            variants: true,
            tags: true,
            // Preserve explicit shipping_template boolean if provided
            ...(typeof body === 'object' && typeof body?.shipping_template === 'boolean' ? { shipping_template: body.shipping_template } : {})
          };
        }
      }

      if (['POST', 'PUT'].includes(method)) {
        requestOptions.body = typeof outgoingBody === 'string' ? outgoingBody : JSON.stringify(outgoingBody || {});
      }

      // Ensure endpoint doesn't start with /v1 to avoid double path
      const cleanEndpoint = endpoint.startsWith('/v1') ? endpoint.substring(3) : endpoint;
      const url = `${PRINTIFY_API_BASE}${cleanEndpoint}`;
      console.log(`[proxy] Outgoing -> ${method} ${url}`);
      console.log('[proxy] Outgoing headers:', requestOptions.headers);
      if (requestOptions.body) {
        console.log('[proxy] Outgoing body:', requestOptions.body);
      }
      
      const response = await fetch(url, requestOptions);
      console.log('[proxy] Response status:', response.status);
      console.log('[proxy] Response headers:', Object.fromEntries([...response.headers.entries()]));

      const rawText = await response.text();
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (err) {
        console.error('[proxy] Error parsing JSON response:', err);
        console.error('[proxy] Raw response body snippet:', rawText?.slice(0, 1000));
        data = { raw: rawText };
      }

      if (!response.ok) {
        console.error('[proxy] Printify error', { url, status: response.status, body: data });
      } else {
        console.log('[proxy] Printify success response type:', typeof data);
        console.log('[proxy] Is array?', Array.isArray(data));
        console.log('[proxy] Response data keys:', Object.keys(data));
        if (Array.isArray(data)) {
          console.log('[proxy] Array length:', data.length);
        }
      }

      console.log(`[proxy] ${method} ${endpoint} -> ${response.status}`);

      /* ── Return unified response to client ── */
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify(
          response.ok
            ? { success: true, data }
            : {
                success: false,
                error: data.error?.message || data.message || `HTTP ${response.status}`,
                details: {
                  upstream: data,
                  outgoing: { method, url, headers: requestOptions.headers, body: requestOptions.body }
                }
              }
        )
      };
    } catch (err) {
      console.error('Proxy error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
    }
  } catch (outerErr) {
    console.error('Auth/API key retrieval error:', outerErr);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: outerErr.message }) };
  }
};