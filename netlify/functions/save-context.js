// Save product context (brand, design, placements, audience) using Supabase
const { getSupabase } = require('./_supabase_node.js');

exports.handler = async (event, context) => {
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
    const {
      productId,
      brand,
      designPrompt,
      designDetails,
      placements,
      audience,
      extra
    } = body || {};

    if (!productId) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'productId is required' }) };
    }

    const supabase = getSupabase(true);
    const { data, error: upsertErr } = await supabase
      .from('product_contexts')
      .upsert([
        {
          product_id: productId,
          brand: brand ?? null,
          design_prompt: designPrompt ?? null,
          design_details: designDetails ?? null,
          placements: placements ?? null,
          audience: audience ?? null,
          extra: extra ?? null,
          updated_at: new Date().toISOString()
        }
      ], { onConflict: 'product_id' })
      .select('*')
      .single();

    if (upsertErr) throw new Error(upsertErr.message);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
  } catch (error) {
    console.error('save-context error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: error.message }) };
  }
};
