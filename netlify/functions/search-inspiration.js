exports.handler = async (event, context) => {
  const { default: fetch } = await import('node-fetch');
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { keyword } = JSON.parse(event.body);

    if (!keyword) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Keyword is required' })
      };
    }
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f8ef46c3bdmshfc05e35f2c240c0p139278jsn0518b1cee1eb';

    if (!RAPIDAPI_KEY) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'RapidAPI key is not configured.' })
        }
    }

    const url = `https://unofficial-pinterest-api.p.rapidapi.com/pinterest/pins/relevance?keyword=${encodeURIComponent(keyword)}&num=20`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-host': 'unofficial-pinterest-api.p.rapidapi.com',
        'x-rapidapi-key': RAPIDAPI_KEY
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: data.message || 'Failed to fetch from Pinterest API' })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error('Search Inspiration Proxy Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
