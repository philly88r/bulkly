const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

exports.handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const { apiKey } = JSON.parse(event.body || '{}');
    
    if (!apiKey) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'API key is required' })
      };
    }

    // Debug: Log API key details
    console.log('API Key received:', {
      type: typeof apiKey,
      length: apiKey?.length,
      sample: apiKey?.substring(0, 20) + '...',
      isString: typeof apiKey === 'string',
      hasValidChars: /^[a-zA-Z0-9_.-]+$/.test(apiKey)
    });

    // Validate API key format before testing (relaxed validation for Printify keys)
    if (typeof apiKey !== 'string' || apiKey.length < 10 || !/^[a-zA-Z0-9_.-]+$/.test(apiKey)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: `Invalid API key format. Received: type=${typeof apiKey}, length=${apiKey?.length}, sample=${apiKey?.substring(0, 10)}...` 
        })
      };
    }

    // Test the API key by making a simple request to Printify
    const response = await fetch('https://api.printify.com/v1/shops.json', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Printify-POD-Manager/1.0'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true, 
          message: 'API key is valid',
          shopsCount: data.length || 0
        })
      };
    } else {
      const errorData = await response.text();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'Invalid API key or connection failed',
          details: errorData
        })
      };
    }

  } catch (error) {
    console.error('Error testing Printify API:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Internal server error' })
    };
  }
};
