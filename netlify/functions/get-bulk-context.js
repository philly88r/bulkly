// Get bulk product context from database
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
    const sessionId = params.sessionId;

    if (!sessionId) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'sessionId parameter is required' }) };
    }

    const supabase = getSupabase(true);
    const { data, error } = await supabase
      .from('product_contexts')
      .select('*')
      .eq('product_id', sessionId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No rows found - return empty context
        return { 
          statusCode: 200, 
          headers, 
          body: JSON.stringify({ 
            success: true, 
            data: {
              selectedProducts: [],
              providerSelection: {},
              selectedPrintAreas: {},
              selectedImages: {},
              designPrompt: '',
              step: 'step1'
            }
          }) 
        };
      }
      throw new Error(error.message);
    }

    // Extract placements data
    const placements = data.placements || {};
    const contextData = {
      selectedProducts: placements.selectedProducts || [],
      providerSelection: placements.providerSelection || {},
      selectedPrintAreas: placements.selectedPrintAreas || {},
      selectedImages: placements.selectedImages || {},
      productImageMap: placements.productImageMap || {},
      designPrompt: data.design_prompt || '',
      step: placements.step || 'step1',
      lastUpdated: placements.lastUpdated
    };

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        data: contextData 
      }) 
    };

  } catch (error) {
    console.error('get-bulk-context error:', error);
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
