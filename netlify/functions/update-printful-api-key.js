const { getSupabase } = require('./_supabase_node');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

const simpleEncrypt = (text, key) => {
  const keyLength = key.length;
  const result = [];
  for (let i = 0; i < text.length; i++) {
    result.push(text.charCodeAt(i) ^ key.charCodeAt(i % keyLength));
  }
  return Buffer.from(result).toString('base64');
};

exports.handler = async (event) => {
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
    return { statusCode: 405, headers, body: JSON.stringify({ success:false, error:'Method not allowed' }) };
  }

  try {
    const token = event.headers.authorization?.split(' ')[1];
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ success:false, error:'Authentication required' }) };

    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.sub || decoded.id;

    const { apiKey } = JSON.parse(event.body || '{}');
    if (!apiKey) return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'API key is required' }) };

    const supabase = getSupabase(true);
    const encrypted = simpleEncrypt(apiKey, JWT_SECRET);

    const { error } = await supabase
      .from('users')
      .update({ printful_api_key_encrypted: encrypted })
      .eq('id', userId);

    if (error) throw error;

    return { statusCode: 200, headers, body: JSON.stringify({ success:true, message:'Printful API key saved' }) };
  } catch (err) {
    console.error('update-printful-api-key error:', err);
    const statusCode = err.name === 'JsonWebTokenError' ? 401 : 500;
    return { statusCode, headers, body: JSON.stringify({ success:false, error:'Failed to save Printful API key.' }) };
  }
};
