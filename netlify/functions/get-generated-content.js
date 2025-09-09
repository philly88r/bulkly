// netlify/functions/get-generated-content.js
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const { product_id } = event.queryStringParameters;
    const authHeader = event.headers.authorization;

    if (!product_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'product_id is required' })
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Ensure user is authenticated, though we don't need to check ownership for this specific content

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase
      .from('ai_generated_content')
      .select('title, description, tags, key_features')
      .eq('product_id', product_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      console.error('Error fetching generated content:', error);
      if (error.code === 'PGRST116') { // "The result contains 0 rows"
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ success: false, error: 'No content found for this product.' })
        };
      }
      throw error;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};
