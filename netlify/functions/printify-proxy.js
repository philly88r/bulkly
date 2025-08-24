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

  if (!API_KEY) {
    console.error('PRINTIFY_API_KEY env var missing');
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Server not configured' }) };
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
        Authorization: `Bearer ${API_KEY}`,
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

    const url = `${PRINTIFY_API_BASE}${endpoint}`;
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
          : { success: false, error: data.error?.message || data.message || `HTTP ${response.status}`, details: { upstream: data, outgoing: { method, url, headers: requestOptions.headers, body: requestOptions.body } } }
      )
    };
  } catch (err) {
    console.error('Proxy error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};