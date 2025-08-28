const { getSupabase } = require('./_supabase_node.js');
const jwt = require('jsonwebtoken');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing or invalid authorization header' }) };
    }

    const token = authHeader.split(' ')[1];
    const body = JSON.parse(event.body || '{}');
    const { blueprintIds } = body;

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET not configured');
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch (err) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    const userId = payload?.sub ?? payload?.userId;
    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid token payload' }) };
    }

    // Import Printify proxy functionality
    const { simpleDecrypt } = require('./printify-proxy.js');
    const PRINTIFY_API_BASE = 'https://api.printify.com/v1';

    // Get user's encrypted API key
    const supabase = getSupabase(true);
    const { data: user, error } = await supabase
      .from('users')
      .select('printify_api_key_encrypted')
      .eq('id', userId)
      .single();

    if (error || !user || !user.printify_api_key_encrypted) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Printify API key not found' })
      };
    }

    // Decrypt the API key
    const apiKey = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
    
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid API key format' })
      };
    }

    // Fetch print providers for each blueprint
    const results = await Promise.all(
      (blueprintIds || []).map(async (blueprintId) => {
        try {
          const response = await fetch(`${PRINTIFY_API_BASE}/catalog/blueprints/${blueprintId}/print_providers.json`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Printify-POD-Manager/1.0'
            }
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const providers = await response.json();
          
          return {
            blueprintId,
            printProviderId: providers.length > 0 ? providers[0].id : null,
            printProviders: providers,
            success: true
          };
        } catch (error) {
          console.error(`Error fetching providers for ${blueprintId}:`, error);
          return {
            blueprintId,
            printProviderId: null,
            printProviders: [],
            success: false,
            error: error.message
          };
        }
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: results
      })
    };

  } catch (error) {
    console.error('Error fetching print providers:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', details: error.message }) };
  }
};
