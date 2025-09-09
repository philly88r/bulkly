const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Helper function for XOR decryption (matches printify-proxy.js)
function simpleDecrypt(encryptedBase64, key) {
  try {
    const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
    const keyLength = key.length;
    const result = [];
    
    for (let i = 0; i < encryptedBytes.length; i++) {
      const byte = encryptedBytes[i];
      const keyCharCode = key.charCodeAt(i % keyLength);
      result.push(byte ^ keyCharCode);
    }
    
    return Buffer.from(result).toString('utf8');
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const { url, file_name } = JSON.parse(event.body);
    const authHeader = event.headers.authorization;
    
    if (!url || !file_name) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'URL and file_name are required' })
      };
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Authentication required' })
      };
    }

    const token = authHeader.split(' ')[1];
    
    // Get user's Printify API key from database
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.sub || decoded.id;

    // Fetch the user's encrypted API key
    const { data: user, error } = await supabase
      .from('users')
      .select('printify_api_key_encrypted')
      .eq('id', userId)
      .single();

    if (error || !user || !user.printify_api_key_encrypted) {
      console.error('Error fetching user API key:', error);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'Printify API key not found' })
      };
    }

    // Decrypt the API key
    const apiKey = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
    if (!apiKey) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'Failed to decrypt API key' })
      };
    }

    // Upload image to Printify
    const response = await fetch('https://api.printify.com/v1/uploads/images.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        file_name: file_name,
        url: url
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        image_id: data.id
      })
    };

  } catch (error) {
    console.error('Error uploading image:', error);
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
