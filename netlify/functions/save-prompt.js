// Save AI prompts and product data to Supabase
const { getSupabase } = require('./_supabase_node.js');

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);

    const { productId, prompt, response, metadata } = body;

    // Extract additional data from metadata
    const {
      brand,
      designDetails,
      placements,
      audience,
      extra
    } = metadata || {};

    const supabase = getSupabase(true);
    
    // Upsert into product_contexts table
    const { data, error } = await supabase
      .from('product_contexts')
      .upsert({
        product_id: productId,
        brand: brand || response?.brand || '',
        design_prompt: prompt,
        design_details: designDetails || response?.designDetails || null,
        placements: placements || response?.placements || null,
        audience: audience || response?.audience || null,
        extra: {
          ...extra,
          response: response,
          metadata: metadata
        }
      }, {
        onConflict: 'product_id'
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);

    return { statusCode: 200, headers, body: JSON.stringify({
      success: true,
      data
    }) };

  } catch (error) {
    console.error('Save prompt error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ 
      error: error.message 
    }) };
  }
};
