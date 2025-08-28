const jwt = require('jsonwebtoken');
const { getSupabase } = require('./_supabase_node');

// Helper function for XOR decryption (matches update-api-key.js encryption)
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

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const supabase = getSupabase(true);

    try {
        const authHeader = event.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: 'Missing or invalid authorization header' };
        }
        
        const token = authHeader.split(' ')[1];
        if (!token) {
            return { statusCode: 401, body: 'Missing token' };
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('Decoded JWT:', decoded);
        const userId = decoded.sub || decoded.id;
        console.log('User ID:', userId);

        if (!userId) {
            return { statusCode: 401, body: 'Invalid token - no user ID found' };
        }

        // Fetch the user's encrypted API key
        const { data: user, error } = await supabase
            .from('users')
            .select('printify_api_key_encrypted')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Error fetching user API key:', error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Database error while fetching API key.' }) };
        }

        console.log('User data from database:', user);
        
        if (!user || !user.printify_api_key_encrypted) {
            console.log('No API key found for user');
            return { statusCode: 200, body: JSON.stringify({ apiKey: null }) };
        }

        // Decrypt the API key
        const decryptedApiKey = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);

        return {
            statusCode: 200,
            body: JSON.stringify({ apiKey: decryptedApiKey })
        };

    } catch (error) {
        console.error('Get API key error:', error);
        if (error.name === 'JsonWebTokenError') {
            return { statusCode: 401, body: 'Invalid token' };
        }
        return { statusCode: 500, body: 'Internal Server Error' };
    }
};
