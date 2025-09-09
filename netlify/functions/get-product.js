// netlify/functions/get-product.js
// Securely fetch a Printify product by ID using the authenticated user's API key

const fetch = require('node-fetch');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const { shop_id: shopId, product_id: productId } = event.queryStringParameters || {};

    if (!shopId || !productId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Missing shop_id or product_id' }) };
    }

    // Extract JWT token for user authentication
    let authToken = null;
    if (event.headers.authorization) {
      authToken = event.headers.authorization.replace(/^Bearer\s+/i, '');
    } else if (event.headers.Authorization) {
      authToken = event.headers.Authorization.replace(/^Bearer\s+/i, '');
    }

    if (!authToken) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Unauthorized - No token' }) };
    }

    // Resolve user's Printify API key from Supabase using the same logic as create-product.js
    const jwt = require('jsonwebtoken');
    const { createClient } = require('@supabase/supabase-js');

    function simpleDecrypt(encryptedBase64, key) {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyLength = key.length;
      const result = [];
      for (let i = 0; i < encryptedBytes.length; i++) {
        result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
      }
      return Buffer.from(result).toString('utf8');
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
    const userId = decoded.sub || decoded.id;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printify_api_key_encrypted')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.printify_api_key_encrypted) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Printify API key not found for user.' }) };
    }

    const printifyApiToken = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
    if (!printifyApiToken) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Invalid Printify API key.' }) };
    }

    const url = `https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${printifyApiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { statusCode: resp.status, headers: cors, body: JSON.stringify({ success: false, error: 'Failed to fetch product', details: text }) };
    }

    const product = await resp.json();
    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, product }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: e.message || 'Server error' }) };
  }
};
