const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    const { endpoint, method = 'GET', body } = JSON.parse(event.body);
    
    if (!endpoint) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Endpoint is required' })
      };
    }

    // Pinterest API configuration
    const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN;
    
    if (!PINTEREST_ACCESS_TOKEN) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Pinterest access token not configured' })
      };
    }

    const pinterestUrl = `https://api.pinterest.com/v5${endpoint}`;
    
    const requestOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${PINTEREST_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    if (body && method !== 'GET') {
      requestOptions.body = body;
    }

    console.log('Making Pinterest API request:', {
      url: pinterestUrl,
      method,
      hasBody: !!body
    });

    const response = await fetch(pinterestUrl, requestOptions);
    const responseData = await response.text();

    console.log('Pinterest API response:', {
      status: response.status,
      statusText: response.statusText,
      data: responseData.substring(0, 500) + (responseData.length > 500 ? '...' : '')
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({
          error: `Pinterest API error: ${response.status} ${response.statusText}`,
          details: responseData
        })
      };
    }

    let data;
    try {
      data = JSON.parse(responseData);
    } catch (e) {
      data = { raw: responseData };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data
      })
    };

  } catch (error) {
    console.error('Pinterest Proxy Error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};
