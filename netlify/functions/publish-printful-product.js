const { makeProxyCall, unwrapProxyResponse, createResponse } = require('./_supabase_node');

exports.handler = async (event, context) => {
  console.log('[PUBLISH-PRINTFUL] Function invoked');
  console.log('[PUBLISH-PRINTFUL] Event method:', event.httpMethod);
  
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  try {
    // Parse request body
    console.log('[PUBLISH-PRINTFUL] Event body:', event.body);
    const body = JSON.parse(event.body || '{}');
    const { 
      product_name,
      external_id,
      catalog_product_id,
      catalog_variant_ids,
      design_file_url,
      retail_price = "29.99",
      sku_prefix = "PF",
      store_id,
      auto_resize = true
    } = body;

    if (!product_name || !catalog_product_id || !catalog_variant_ids || !design_file_url) {
      return createResponse(400, { 
        error: 'Missing required parameters: product_name, catalog_product_id, catalog_variant_ids, design_file_url' 
      });
    }

    console.log('[PUBLISH-PRINTFUL] Parameters:');
    console.log('  - product_name:', product_name);
    console.log('  - catalog_product_id:', catalog_product_id);
    console.log('  - catalog_variant_ids:', catalog_variant_ids);
    console.log('  - design_file_url:', design_file_url);
    console.log('  - auto_resize:', auto_resize);

    // Step 1: Get print area specifications
    console.log('[PUBLISH-PRINTFUL] Step 1: Getting print area specifications...');
    const printAreaResponse = await makeProxyCall(
      event,
      `/.netlify/functions/get-print-area-specs`,
      {
        method: 'POST',
        body: JSON.stringify({ catalog_product_id, store_id })
      }
    );
    
    const printAreaData = unwrapProxyResponse(printAreaResponse);
    if (!printAreaData.success) {
      throw new Error(`Failed to get print area specs: ${printAreaData.error}`);
    }

    console.log('[PUBLISH-PRINTFUL] Print area specs:', printAreaData.print_area_specs);

    // Step 2: Use provided design URL as-is (no resizing). Log exact Printful dims for traceability.
    let finalDesignUrl = design_file_url;
    try {
      if (printAreaData.print_area_specs.length > 0) {
        const primaryPlacement = printAreaData.print_area_specs[0]; // Use first placement
        const { width_pixels, height_pixels, dpi } = primaryPlacement.print_area || {};
        console.log(`[PUBLISH-PRINTFUL] EXACT DIMENSIONS (Printful): ${width_pixels}x${height_pixels} @ ${dpi || 'n/a'} DPI; using provided design URL as-is (no resize).`);
      }
    } catch (_) {}

    // Step 3: Create sync variants for each catalog variant
    console.log('[PUBLISH-PRINTFUL] Step 3: Creating sync variants...');
    const sync_variants = catalog_variant_ids.map((variant_id, index) => {
      const placement = printAreaData.print_area_specs[0]; // Use primary placement
      
      return {
        external_id: `${external_id || product_name.replace(/\s+/g, '-')}-${variant_id}`,
        variant_id: parseInt(variant_id, 10),
        retail_price: retail_price,
        is_ignored: false,
        sku: `${sku_prefix}-${variant_id}`,
        files: [{
          type: placement?.placement || "default",
          url: finalDesignUrl,
          options: [{ id: "template_type", value: "native" }],
          filename: `${product_name.replace(/\s+/g, '-')}-${placement?.placement || 'front'}.png`,
          visible: true
        }],
        options: printAreaData.product_options.includes('stitch_color') ? 
          [{ id: "stitch_color", value: "black" }] : [],
        availability_status: "active"
      };
    });

    // Step 4: Create the sync product
    console.log('[PUBLISH-PRINTFUL] Step 4: Publishing product to Printful...');
    const apiHeaders = {}; // Using OAuth - no store ID header needed
    
    const publishPayload = {
      sync_product: {
        external_id: external_id || product_name.replace(/\s+/g, '-'),
        name: product_name,
        thumbnail: finalDesignUrl, // Use the design as thumbnail
        is_ignored: false
      },
      sync_variants: sync_variants
    };

    console.log('[PUBLISH-PRINTFUL] Publishing payload:', JSON.stringify(publishPayload, null, 2));

    const publishResponse = await makeProxyCall(
      event,
      `/store/products`,
      {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(publishPayload)
      }
    );
    
    const publishResult = unwrapProxyResponse(publishResponse);
    console.log('[PUBLISH-PRINTFUL] Publish result:', publishResult);

    if (publishResult.code && publishResult.code !== 200) {
      throw new Error(`Printful API error: ${JSON.stringify(publishResult)}`);
    }

    // Step 5: Generate and store mockups (separate from publishing)
    console.log('[PUBLISH-PRINTFUL] Step 5: Generating mockups...');
    let mockupData = null;
    
    try {
      const mockupResponse = await makeProxyCall(
        event,
        `/.netlify/functions/generate-and-store-mockups`,
        {
          method: 'POST',
          body: JSON.stringify({
            catalog_product_id: catalog_product_id,
            catalog_variant_ids: catalog_variant_ids,
            // IMPORTANT: Use the original generated image for mockups, not the resized print file
            design_file_url: design_file_url,
            mockup_style_ids: [], // Use default styles
            external_id: external_id || product_name.replace(/\s+/g, '-'),
            store_id: store_id
          })
        }
      );
      
      mockupData = unwrapProxyResponse(mockupResponse);
      if (mockupData.success) {
        console.log('[PUBLISH-PRINTFUL] Mockups generated and stored:', mockupData.mockups_generated);
      } else {
        console.warn('[PUBLISH-PRINTFUL] Mockup generation failed:', mockupData.error);
      }
    } catch (mockupError) {
      console.warn('[PUBLISH-PRINTFUL] Mockup generation error:', mockupError.message);
    }

    // Step 5.5: Attach mockups to the Printful product gallery (PUT /store/products/{id})
    try {
      const productId = publishResult.result?.id || publishResult.id;
      if (productId) {
        const gallery = [];
        // Always include the main design image first
        if (design_file_url && typeof design_file_url === 'string') {
          gallery.push(design_file_url.trim());
        }
        // Include all mockups we just generated
        if (mockupData && mockupData.success && Array.isArray(mockupData.mockup_urls)) {
          mockupData.mockup_urls.forEach(m => {
            const u = (m && (m.mockup_url || m.url)) ? String(m.mockup_url || m.url).trim() : '';
            if (u) gallery.push(u);
          });
        }
        // Deduplicate and clamp to a reasonable number (Printful UI shows ~12 well)
        const unique = Array.from(new Set(gallery)).slice(0, 16);
        if (unique.length > 0) {
          const putPayload = {
            sync_product: {
              images: unique.map(u => ({ src: u }))
            }
          };
          console.log('[PUBLISH-PRINTFUL] Attaching images to product via PUT /store/products/{id}, count:', unique.length);
          const updateRes = await makeProxyCall(
            event,
            `/store/products/${encodeURIComponent(String(productId))}`,
            {
              method: 'PUT',
              headers: apiHeaders,
              body: JSON.stringify(putPayload)
            }
          );
          const updateData = unwrapProxyResponse(updateRes);
          console.log('[PUBLISH-PRINTFUL] Images update response snapshot:', updateData && (updateData.result ? 'ok: result present' : JSON.stringify(updateData).slice(0,400)));
        } else {
          console.log('[PUBLISH-PRINTFUL] No images to attach to gallery (unique list empty).');
        }
      } else {
        console.warn('[PUBLISH-PRINTFUL] Missing product id, cannot attach images.');
      }
    } catch (imgAttachErr) {
      console.warn('[PUBLISH-PRINTFUL] Failed to attach mockups to product gallery (non-fatal):', imgAttachErr?.message || imgAttachErr);
    }

    // Step 6: Return success response
    const response = {
      success: true,
      sync_product_id: publishResult.result?.id || publishResult.id,
      external_id: publishResult.result?.external_id || publishResult.external_id,
      product_name: publishResult.result?.name || publishResult.name,
      variants_created: publishResult.result?.variants || sync_variants.length,
      print_area_specs: printAreaData.print_area_specs,
      final_design_url: finalDesignUrl,
      auto_resized: auto_resize && finalDesignUrl !== design_file_url,
      mockups: mockupData?.success ? {
        generated: mockupData.mockups_generated,
        stored: mockupData.stored_in_database,
        urls: mockupData.mockup_urls
      } : null
    };

    console.log('[PUBLISH-PRINTFUL] Product published successfully with mockups:', response.sync_product_id);
    return createResponse(200, response);

  } catch (error) {
    console.error('[PUBLISH-PRINTFUL] Error:', error);
    return createResponse(500, { 
      error: 'Failed to publish product to Printful',
      details: error.message 
    });
  }
};
