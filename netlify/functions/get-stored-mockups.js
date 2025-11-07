const { createClient } = require('@supabase/supabase-js');
const { createResponse } = require('./_supabase_node');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

exports.handler = async (event, context) => {
  console.log('[GET-STORED-MOCKUPS] Function invoked');
  
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  try {
    let external_id, catalog_product_id;
    
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      external_id = body.external_id;
      catalog_product_id = body.catalog_product_id;
    } else {
      const params = new URLSearchParams(event.queryStringParameters || {});
      external_id = params.get('external_id');
      catalog_product_id = params.get('catalog_product_id');
    }

    if (!external_id && !catalog_product_id) {
      return createResponse(400, { 
        error: 'Must provide either external_id or catalog_product_id' 
      });
    }

    console.log('[GET-STORED-MOCKUPS] Fetching mockups for:', { external_id, catalog_product_id });

    // Build query
    let query = supabase
      .from('product_mockups')
      .select(`
        id,
        external_id,
        catalog_product_id,
        design_file_url,
        generated_at,
        mockup_count,
        mockup_urls (
          id,
          catalog_variant_id,
          mockup_style_id,
          mockup_url,
          placement,
          technique,
          created_at
        )
      `);

    if (external_id) {
      query = query.eq('external_id', external_id);
    } else {
      query = query.eq('catalog_product_id', parseInt(catalog_product_id, 10));
    }

    const { data: products, error } = await query;

    if (error) {
      console.error('[GET-STORED-MOCKUPS] Query error:', error);
      throw new Error(`Failed to fetch mockups: ${error.message}`);
    }

    if (!products || products.length === 0) {
      return createResponse(404, { 
        error: 'No mockups found for the specified product',
        external_id,
        catalog_product_id 
      });
    }

    const product = products[0];
    const mockups = product.mockup_urls || [];

    // Check if mockups are expired (24+ hours old)
    const now = new Date();
    const generatedAt = new Date(product.generated_at);
    const hoursOld = (now - generatedAt) / (1000 * 60 * 60);
    const isExpired = hoursOld > 24;

    console.log('[GET-STORED-MOCKUPS] Found', mockups.length, 'mockups, age:', hoursOld.toFixed(1), 'hours');

    const response = {
      success: true,
      product: {
        id: product.id,
        external_id: product.external_id,
        catalog_product_id: product.catalog_product_id,
        design_file_url: product.design_file_url,
        generated_at: product.generated_at,
        mockup_count: product.mockup_count
      },
      mockups: mockups.map(mockup => ({
        id: mockup.id,
        catalog_variant_id: mockup.catalog_variant_id,
        mockup_style_id: mockup.mockup_style_id,
        mockup_url: mockup.mockup_url,
        placement: mockup.placement,
        technique: mockup.technique,
        created_at: mockup.created_at
      })),
      metadata: {
        total_mockups: mockups.length,
        hours_old: parseFloat(hoursOld.toFixed(1)),
        is_expired: isExpired,
        expires_in_hours: isExpired ? 0 : parseFloat((24 - hoursOld).toFixed(1))
      }
    };

    return createResponse(200, response);

  } catch (error) {
    console.error('[GET-STORED-MOCKUPS] Error:', error);
    return createResponse(500, { 
      error: 'Failed to get stored mockups',
      details: error.message 
    });
  }
};
