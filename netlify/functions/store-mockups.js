const { createClient } = require('@supabase/supabase-js');
const { createResponse } = require('./_supabase_node');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

exports.handler = async (event, context) => {
  console.log('[STORE-MOCKUPS] Function invoked');
  
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { 
      external_id,
      catalog_product_id,
      mockups,
      design_file_url,
      generated_at
    } = body;

    if (!external_id || !catalog_product_id || !mockups) {
      return createResponse(400, { 
        error: 'Missing required: external_id, catalog_product_id, mockups' 
      });
    }

    console.log('[STORE-MOCKUPS] Storing', mockups.length, 'mockups for product:', external_id);

    // Create or update product mockups record
    const productData = {
      external_id,
      catalog_product_id: parseInt(catalog_product_id, 10),
      design_file_url,
      generated_at: generated_at || new Date().toISOString(),
      mockup_count: mockups.length,
      updated_at: new Date().toISOString()
    };

    // Upsert product record
    const { data: productRecord, error: productError } = await supabase
      .from('product_mockups')
      .upsert(productData, { 
        onConflict: 'external_id',
        ignoreDuplicates: false 
      })
      .select()
      .single();

    if (productError) {
      console.error('[STORE-MOCKUPS] Product upsert error:', productError);
      throw new Error(`Failed to store product record: ${productError.message}`);
    }

    console.log('[STORE-MOCKUPS] Product record stored:', productRecord.id);

    // Delete existing mockup URLs for this product
    const { error: deleteError } = await supabase
      .from('mockup_urls')
      .delete()
      .eq('product_mockup_id', productRecord.id);

    if (deleteError) {
      console.warn('[STORE-MOCKUPS] Delete old mockups warning:', deleteError.message);
    }

    // Insert new mockup URLs
    const mockupRecords = mockups.map(mockup => ({
      product_mockup_id: productRecord.id,
      catalog_variant_id: mockup.catalog_variant_id,
      mockup_style_id: mockup.mockup_style_id,
      mockup_url: mockup.mockup_url,
      placement: mockup.placement,
      technique: mockup.technique,
      created_at: new Date().toISOString()
    }));

    const { data: insertedMockups, error: insertError } = await supabase
      .from('mockup_urls')
      .insert(mockupRecords)
      .select();

    if (insertError) {
      console.error('[STORE-MOCKUPS] Insert error:', insertError);
      throw new Error(`Failed to store mockup URLs: ${insertError.message}`);
    }

    console.log('[STORE-MOCKUPS] Stored', insertedMockups.length, 'mockup URLs');

    const response = {
      success: true,
      product_mockup_id: productRecord.id,
      external_id: productRecord.external_id,
      mockups_stored: insertedMockups.length,
      catalog_product_id: productRecord.catalog_product_id
    };

    return createResponse(200, response);

  } catch (error) {
    console.error('[STORE-MOCKUPS] Error:', error);
    return createResponse(500, { 
      error: 'Failed to store mockups',
      details: error.message 
    });
  }
};
