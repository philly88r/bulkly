// Get product context from product_contexts table
const { getSupabase } = require('./_supabase_node.js');

exports.handler = async (event, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const productId = params.productId;

    if (!productId) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'productId parameter is required' }) };
    }

    const supabase = getSupabase(true);
    const { data, error } = await supabase
      .from('product_contexts')
      .select('*')
      .eq('product_id', productId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No rows found
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: null }) };
      }
      throw new Error(error.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };

  } catch (error) {
    console.error('get-context error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: error.message }) };
  }
};
