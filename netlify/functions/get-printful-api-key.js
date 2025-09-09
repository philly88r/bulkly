const jwt = require('jsonwebtoken');
const { getSupabase } = require('./_supabase_node');

function simpleDecrypt(encryptedBase64, key) {
  try {
    const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
    const keyLength = key.length;
    const result = [];
    for (let i = 0; i < encryptedBytes.length; i++) {
      result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
    }
    return Buffer.from(result).toString('utf8');
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const supabase = getSupabase(true);
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, body: 'Missing or invalid authorization header' };
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.sub || decoded.id;
    if (!userId) {
      return { statusCode: 401, body: 'Invalid token - no user ID found' };
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('printful_api_key_encrypted')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('DB error fetching Printful key:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Database error while fetching Printful key.' }) };
    }

    if (!user || !user.printful_api_key_encrypted) {
      return { statusCode: 200, body: JSON.stringify({ apiKey: null }) };
    }

    const decrypted = simpleDecrypt(user.printful_api_key_encrypted, process.env.JWT_SECRET);
    return { statusCode: 200, body: JSON.stringify({ apiKey: decrypted }) };
  } catch (error) {
    console.error('get-printful-api-key error:', error);
    const statusCode = error.name === 'JsonWebTokenError' ? 401 : 500;
    return { statusCode, body: 'Internal Server Error' };
  }
};
