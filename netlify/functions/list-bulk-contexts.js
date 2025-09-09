// List recent bulk product contexts for the current user (unauthenticated table, keyed by session/product_id)
// Returns recent sessions with placements summary for the dashboard
const { getSupabase } = require('./_supabase_node.js');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const limit = Math.min(parseInt(params.limit || '20', 10), 50);

    const supabase = getSupabase(true);
    const { data, error } = await supabase
      .from('product_contexts')
      .select('product_id, design_prompt, placements, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    // Shape for dashboard
    const sessions = (data || []).map((row) => {
      const p = row.placements || {};
      const selectedProducts = Array.isArray(p.selectedProducts) ? p.selectedProducts : [];
      const selectedImages = p.selectedImages || {};
      const selectedPrintAreas = p.selectedPrintAreas || {};
      const productImageMap = p.productImageMap || {};
      const step = p.step || 'step1';

      const totalProducts = selectedProducts.length;
      const imagesAssigned = Object.values(selectedImages).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
      const productsWithAreas = Object.keys(selectedPrintAreas).length;

      // collect recent product thumbnails (up to 4)
      const productThumbs = [];
      for (const pid of selectedProducts) {
        const img = productImageMap[pid];
        if (img) productThumbs.push({ productId: pid, imageUrl: img });
        if (productThumbs.length >= 4) break;
      }

      return {
        sessionId: row.product_id,
        updatedAt: row.updated_at,
        designPrompt: row.design_prompt || '',
        totals: { totalProducts, imagesAssigned, productsWithAreas },
        thumbnails: productThumbs,
        step,
        raw: { selectedProducts, selectedImages, selectedPrintAreas, productImageMap },
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: sessions }) };
  } catch (err) {
    console.error('list-bulk-contexts error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
