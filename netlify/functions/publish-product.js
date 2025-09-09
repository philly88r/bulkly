// /netlify/functions/publish-product.js
const fetch = require('node-fetch');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };

  try {
    const { shopId, productId } = JSON.parse(event.body || '{}');
    if (!shopId || !productId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Missing shopId or productId' }) };
    }

    // Read Authorization header (JWT)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Authorization header required' }) };
    }

    // Resolve origin to call internal function
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    const origin = `${proto}://${host}`;

    // Fetch stored Printify API key for this user
    const apiKeyRes = await fetch(`${origin}/.netlify/functions/get-api-key`, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });

    if (!apiKeyRes.ok) {
      const text = await apiKeyRes.text();
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: `Failed to get API key: ${text}` }) };
    }

    const { apiKey } = await apiKeyRes.json();
    if (!apiKey) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'No API key found' }) };
    }

    // Call Printify publish endpoint
    const res = await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${productId}/publish.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: true, description: true, images: true, variants: true, tags: true, key_features: true })
    });

    if (!res.ok) {
      const errorText = await res.text();
      const status = res.status;
      return { statusCode: status, headers: cors, body: JSON.stringify({ success: false, error: errorText || `Publish failed: ${status}` }) };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
