const { getSupabase } = require('./_supabase_node');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// A real implementation would use a more secure, dedicated encryption service or library
// For this example, we'll use a simple XOR cipher for demonstration purposes.
const simpleEncrypt = (text, key) => {
  const keyLength = key.length;
  const result = [];
  
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const keyCharCode = key.charCodeAt(i % keyLength);
    result.push(charCode ^ keyCharCode);
  }
  
  return Buffer.from(result).toString('base64');
};

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
    const token = event.headers.authorization?.split(' ')[1];
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Authentication required' }) };
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.sub;

    const { apiKey } = JSON.parse(event.body);
    if (!apiKey) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'API key is required' }) };
    }

    const supabase = getSupabase(true);
    const encryptedApiKey = simpleEncrypt(apiKey, JWT_SECRET);

    const { error } = await supabase
      .from('users')
      .update({ printify_api_key_encrypted: encryptedApiKey })
      .eq('id', userId);

    if (error) {
      throw error;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'API key updated successfully' }),
    };
  } catch (error) {
    console.error('API key update error:', error);
    const statusCode = error.name === 'JsonWebTokenError' ? 401 : 500;
    return { statusCode, headers, body: JSON.stringify({ success: false, error: 'Failed to update API key.' }) };
  }
};
