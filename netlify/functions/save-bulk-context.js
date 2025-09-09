// Save bulk product context (providers, print areas, image assignments) to database
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
      sessionId,
      designPrompt,
      selectedProducts,
      providerSelection,
      selectedPrintAreas,
      selectedImages,
      step
    } = body || {};

    if (!sessionId) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'sessionId is required' }) };
    }

    const supabase = getSupabase(true);
    
    // Store bulk context using sessionId as product_id
    const contextData = {
      product_id: sessionId,
      design_prompt: designPrompt || null,
      placements: {
        selectedProducts: selectedProducts || [],
        providerSelection: providerSelection || {},
        selectedPrintAreas: selectedPrintAreas || {},
        selectedImages: selectedImages || {},
        productImageMap: body.productImageMap || {},
        step: step || 'unknown',
        lastUpdated: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    };

    const { data, error: upsertErr } = await supabase
      .from('product_contexts')
      .upsert([contextData], { onConflict: 'product_id' })
      .select('*')
      .single();

    if (upsertErr) throw new Error(upsertErr.message);

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        data,
        message: `Bulk context saved for step ${step}` 
      }) 
    };

  } catch (error) {
    console.error('save-bulk-context error:', error);
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
