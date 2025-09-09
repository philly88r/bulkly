const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const { shopId, productId, print_areas, variants, title, description, tags, images } = JSON.parse(event.body || '{}');
    
    if (!shopId || !productId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'shopId and productId are required' })
      };
    }

    if (!print_areas && !variants && !title && !description && !tags && !images) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'At least one of title, description, tags, print_areas, images, or variants is required' })
      };
    }

    // Build request body from provided fields
    const body = {};
    if (print_areas) body.print_areas = print_areas;
    if (variants) body.variants = variants;
    if (typeof title === 'string') body.title = title;
    if (typeof description === 'string') body.description = description;
    if (Array.isArray(tags)) body.tags = tags;
    if (Array.isArray(images)) body.images = images;

    // Read Authorization header (JWT)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Authorization header required' }) };
    }

    // Resolve origin to call internal get-api-key
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
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: `Failed to get API key: ${text}` }) };
    }

    const { apiKey } = await apiKeyRes.json();
    if (!apiKey) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'No API key found' }) };
    }

    // Call Printify update endpoint
    const res = await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ success: false, error: errorText || 'Failed to update product' }) };
    }

    const product = await res.json();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        product
      })
    };

  } catch (error) {
    console.error('Error updating product:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
