const { makeProxyCall, unwrapProxyResponse, createResponse } = require('./_supabase_node');

exports.handler = async (event, context) => {
  console.log('[GENERATE-STORE-MOCKUPS] Function invoked');
  
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { 
      catalog_product_id,
      catalog_variant_ids,
      design_file_url,
      mockup_style_ids,
      external_id,
      store_id
    } = body;

    if (!catalog_product_id || !catalog_variant_ids || !design_file_url) {
      return createResponse(400, { 
        error: 'Missing required: catalog_product_id, catalog_variant_ids, design_file_url' 
      });
    }

    console.log('[GENERATE-STORE-MOCKUPS] Generating mockups for product:', catalog_product_id);

    // Step 1: Get product specs to determine technique and placement
    const specsResponse = await makeProxyCall(
      event,
      `/.netlify/functions/get-print-area-specs`,
      {
        method: 'POST',
        body: JSON.stringify({ catalog_product_id, store_id })
      }
    );
    
    const specsData = unwrapProxyResponse(specsResponse);
    if (!specsData.success) {
      throw new Error(`Failed to get product specs: ${specsData.error}`);
    }

    const primaryPlacement = specsData.print_area_specs[0];
    const technique = primaryPlacement?.technique || 'dtg';
    const placement = primaryPlacement?.placement || 'front';

    // Step 2: Get design file dimensions first
    let designWidth = null, designHeight = null;
    try {
      const imageResponse = await fetch(design_file_url);
      if (imageResponse.ok) {
        const imageBuffer = await imageResponse.arrayBuffer();
        const sharp = require('sharp');
        const metadata = await sharp(Buffer.from(imageBuffer)).metadata();
        designWidth = metadata.width;
        designHeight = metadata.height;
        console.log('[GENERATE-STORE-MOCKUPS] Design file dimensions:', designWidth, '×', designHeight);
      }
    } catch (e) {
      console.warn('[GENERATE-STORE-MOCKUPS] Could not get design dimensions:', e.message);
    }

    // Step 3: Generate mockups using v2 API with dynamic sizing
    const apiHeaders = {};
    
    const mockupPayload = {
      format: 'png',
      // Use actual design width - no hardcoded sizes
      ...(designWidth && { mockup_width_px: designWidth }),
      products: [{
        source: 'catalog',
        catalog_product_id: parseInt(catalog_product_id, 10),
        catalog_variant_ids: catalog_variant_ids.map(id => parseInt(id, 10)),
        mockup_style_ids: mockup_style_ids || [],
        orientation: 'vertical',
        placements: [{
          placement: placement,
          technique: technique,
          print_area_type: 'simple',
          layers: [{
            type: 'file',
            url: design_file_url,
            position: { width: 100, height: 100, top: 0, left: 0 }
          }]
        }]
      }]
    };

    console.log('[GENERATE-STORE-MOCKUPS] Creating mockup task...');
    const taskResponse = await makeProxyCall(
      event,
      `/v2/mockup-generator/create-task`,
      {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(mockupPayload)
      }
    );
    
    const taskData = unwrapProxyResponse(taskResponse);
    if (!taskData.data?.task_id) {
      throw new Error(`Failed to create mockup task: ${JSON.stringify(taskData)}`);
    }

    const taskId = taskData.data.task_id;
    console.log('[GENERATE-STORE-MOCKUPS] Task created:', taskId);

    // Step 3: Poll for completion (max 60 seconds)
    let mockupResults = null;
    let attempts = 0;
    const maxAttempts = 12; // 60 seconds / 5 second intervals
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      attempts++;
      
      console.log(`[GENERATE-STORE-MOCKUPS] Polling attempt ${attempts}/${maxAttempts}...`);
      
      const resultResponse = await makeProxyCall(
        event,
        `/v2/mockup-generator/tasks?id=${taskId}`,
        { headers: apiHeaders }
      );
      
      const resultData = unwrapProxyResponse(resultResponse);
      
      if (resultData.data && resultData.data.length > 0) {
        const task = resultData.data[0];
        
        if (task.status === 'completed' && task.mockups) {
          mockupResults = task.mockups;
          console.log('[GENERATE-STORE-MOCKUPS] Task completed, found', mockupResults.length, 'mockups');
          break;
        } else if (task.status === 'failed') {
          throw new Error(`Mockup generation failed: ${task.error || 'Unknown error'}`);
        }
      }
    }

    if (!mockupResults) {
      throw new Error('Mockup generation timed out after 60 seconds');
    }

    // Step 4: Extract and organize mockup URLs
    const mockupUrls = mockupResults.map(mockup => ({
      catalog_variant_id: mockup.catalog_variant_id,
      mockup_style_id: mockup.mockup_style_id,
      mockup_url: mockup.mockup_url,
      placement: placement,
      technique: technique
    }));

    // Step 5: Store mockups in database
    console.log('[GENERATE-STORE-MOCKUPS] Storing mockups in database...');
    
    const storeResponse = await makeProxyCall(
      event,
      `/.netlify/functions/store-mockups`,
      {
        method: 'POST',
        body: JSON.stringify({
          external_id: external_id || `product-${catalog_product_id}`,
          catalog_product_id: parseInt(catalog_product_id, 10),
          mockups: mockupUrls,
          design_file_url: design_file_url,
          generated_at: new Date().toISOString()
        })
      }
    );
    
    const storeData = unwrapProxyResponse(storeResponse);
    if (!storeData.success) {
      console.warn('[GENERATE-STORE-MOCKUPS] Failed to store mockups:', storeData.error);
    }

    const response = {
      success: true,
      task_id: taskId,
      mockups_generated: mockupUrls.length,
      mockup_urls: mockupUrls,
      stored_in_database: storeData.success,
      catalog_product_id: parseInt(catalog_product_id, 10),
      external_id: external_id || `product-${catalog_product_id}`
    };

    console.log('[GENERATE-STORE-MOCKUPS] Complete:', response.mockups_generated, 'mockups generated and stored');
    return createResponse(200, response);

  } catch (error) {
    console.error('[GENERATE-STORE-MOCKUPS] Error:', error);
    return createResponse(500, { 
      error: 'Failed to generate and store mockups',
      details: error.message 
    });
  }
};
