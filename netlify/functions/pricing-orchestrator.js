// netlify/functions/pricing-orchestrator.js
const fetch = require('node-fetch');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event, context) => {
  try {
    console.log('[pricing-orchestrator] Function invoked');
    
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (parseError) {
      console.error('[pricing-orchestrator] JSON parse error:', parseError);
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Invalid JSON in request body' }) };
    }
    
    const { products } = body;
    console.log('[pricing-orchestrator] Received products count:', Array.isArray(products) ? products.length : 'not array');

    if (!Array.isArray(products) || products.length === 0) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Missing products array' }) };
    }

    // Normalize Authorization header to 'Bearer <token>' like other functions
    const incomingAuth = event.headers.authorization || event.headers.Authorization || '';
    const token = incomingAuth.replace(/^Bearer\s+/i, '').trim();
    const authHeader = token ? `Bearer ${token}` : '';

    // Enforce JWT like sibling functions
    if (!authHeader) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success:false, error: 'Unauthorized - No token' }) };
    }

    // Derive base URL for calling sibling Netlify functions
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
    const proto = (event.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = event.headers.host;
    const baseUrl = siteUrl || `${proto}://${host}`;
    const results = [];

    console.log('[pricing-orchestrator] Processing', products.length, 'products');
    
    for (const p of products) {
      console.log(`[pricing-orchestrator] Processing product: ${p.title} (${p.catalog_product_id})`);
      
      // Initialize pricing info at the start of each product loop
      let pricingInfo = null;
      let cost = 0;
      
      // 1. Create product via printful-create-product.js
      // Use the placement dimensions directly from the API specs
      let width = Number(p.width) || Number(p.placement?.width) || 0;
      let height = Number(p.height) || Number(p.placement?.height) || 0;
      const dpi = Number(p.dpi) || Number(p.placement?.dpi) || 300;

      console.log(`[pricing-orchestrator] Using dimensions: ${width}x${height} @ ${dpi} DPI`);

      // Validate dimensions are reasonable for print (should be in pixels, not DPI-multiplied)
      if (width > 20000 || height > 20000) {
        console.warn(`[pricing-orchestrator] Suspiciously large dimensions: ${width}x${height}, using fallback`);
        width = 3000; // Fallback to common print size
        height = 3000;
      }
      if (width === 0 || height === 0) {
        console.warn(`[pricing-orchestrator] Invalid dimensions: ${width}x${height}, using fallback`);
        width = 3000;
        height = 3000;
      }
      
      // Extract technique from placement data if available
      const placement = p.placement && (p.placement.placement || p.placement.position) || p.placement || 'front';
      const technique = p.placement?.technique || p.technique || 'sublimation';

      const placement_files = [{
        placement: placement,
        image_url: p.imageUrl,
        width,
        height,
        dpi,
        technique: technique
      }];
      const createPayload = {
        shopId: 'default',
        catalog_product_id: p.catalog_product_id,
        title: p.title,
        description: p.description,
        tags: p.tags,
        key_features: p.keyFeatures,
        materials: p.materials,
        placement_files,
        selling_region: p.selling_region || 'united_states',  
        technique: p.technique || 'sublimation',
        style_id: p.style_id || null
      };

      // 1. Create product via printful-create-product.js (this was missing!)
      let createRes;
      try {
        createRes = await fetch(`${baseUrl}/.netlify/functions/printful-create-product`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify(createPayload)
        }).then(r => r.json());
        
        console.log(`[pricing-orchestrator] Create response:`, JSON.stringify(createRes, null, 2));
      } catch (createError) {
        console.error(`[pricing-orchestrator] Product creation failed for ${p.catalog_product_id}:`, createError.message);
        createRes = { success: false, error: createError.message };
      }

      if (!createRes.success) {
        console.log(`[pricing-orchestrator] Product creation failed, returning error:`, JSON.stringify(createRes, null, 2));
        const normalized = {
          success: false,
          error: createRes.error || 'Product creation failed',
          catalog_product_id: p.catalog_product_id
        };
        results.push(normalized);
        continue;
      }
  
      // 2. Generate mock-ups via generate-mockup-gallery.js
      const gmPayload = {
        catalog_product_id: p.catalog_product_id,
        placement_files,
        count: 10,
        technique: technique,
        style_id: p.style_id || null
      };

      console.log(`[pricing-orchestrator] Mockup payload for ${p.catalog_product_id}:`, {
        catalog_product_id: p.catalog_product_id,
        technique: technique,
        style_id: p.style_id,
        placement_count: placement_files.length
      });

      let mockupRes;
      try {
        mockupRes = await fetch(`${baseUrl}/.netlify/functions/generate-mockup-gallery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify(gmPayload)
        }).then(r => r.json());
        
        console.log(`[pricing-orchestrator] Mockup generation response:`, JSON.stringify(mockupRes, null, 2));
      } catch (mockupError) {
        console.error(`[pricing-orchestrator] Mockup generation failed for ${p.catalog_product_id}:`, mockupError.message);
        mockupRes = { success: false, error: mockupError.message };
      }

      if (mockupRes.pending === true) {
        console.log(`[pricing-orchestrator] Mockup generation is pending for ${p.catalog_product_id}, proceeding with pricing anyway`);
        const mockups = [];
        
        // Get pricing information using the proxy to ensure consistent auth
        let hasPricingError = false;
        try {
          console.log(`[pricing-orchestrator] Getting pricing for product ${p.catalog_product_id} via proxy`);

          const pricingRes = await fetch(`${baseUrl}/.netlify/functions/printful-proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authHeader },
            body: JSON.stringify({
              endpoint: `/v2/catalog-products/${p.catalog_product_id}/pricing`,
              method: 'GET'
            })
          });

          console.log(`[pricing-orchestrator] Pricing response status: ${pricingRes.status}`);

          if (pricingRes.ok) {
            const proxyResponse = await pricingRes.json();
            if (proxyResponse.success) {
              console.log(`[pricing-orchestrator] Pricing data received for ${p.catalog_product_id}:`, JSON.stringify(proxyResponse.data, null, 2));
              pricingInfo = proxyResponse.data.data || proxyResponse.data;

              // Calculate cost from pricing info
              if (pricingInfo && pricingInfo.variants && pricingInfo.variants.length > 0) {
                const firstVariant = pricingInfo.variants[0];
                cost = parseFloat(firstVariant.cost) || 0;
                console.log(`[pricing-orchestrator] Cost calculated: $${cost}`);
              } else {
                console.warn(`[pricing-orchestrator] No variants found in pricing data for ${p.catalog_product_id}`);
                // Try to extract cost from v1 format if present
                if (pricingInfo && pricingInfo.cost) {
                  cost = parseFloat(pricingInfo.cost) || 0;
                }
              }
            } else {
              console.warn(`[pricing-orchestrator] Proxy returned error for pricing ${p.catalog_product_id}:`, proxyResponse.error);
              hasPricingError = true;
            }
          } else {
            const errorText = await pricingRes.text();
            console.warn(`[pricing-orchestrator] Could not get pricing for ${p.catalog_product_id}:`, pricingRes.status, errorText);
            hasPricingError = true;
          }
        } catch (pricingError) {
          console.warn(`[pricing-orchestrator] Pricing fetch error for ${p.catalog_product_id}:`, pricingError.message);
          hasPricingError = true;
        }

        const normalized = {
          success: true,
          product_id: (createRes.product && createRes.product.id) || createRes.product_id,
          title: p.title || (createRes.product && (createRes.product.name || createRes.product.title)) || 'New Product',
          cost,
          pricing: pricingInfo,
          mockups,
          pricing_error: hasPricingError,
          pending: true
        };
        results.push(normalized);
        console.log(`[pricing-orchestrator] Final result for ${p.catalog_product_id} (pending mockup):`, JSON.stringify(normalized, null, 2));
        continue;
      }
      
      if (!mockupRes.success && mockupRes.pending !== true) {
        console.log(`[pricing-orchestrator] Mockup generation failed, using fallback:`, JSON.stringify(mockupRes, null, 2));
        // Surface proxy details if present and keep going
        const mockups = mockupRes.urls || mockupRes.mockups || [];
        console.log(`[pricing-orchestrator] Using fallback mockups due to failure:`, mockups.length, 'mockups');
        
        // Calculate cost from pricing info if available
        if (pricingInfo && pricingInfo.variants && pricingInfo.variants.length > 0) {
          const firstVariant = pricingInfo.variants[0];
          cost = firstVariant.cost || 0;
        }
        
        const normalized = {
          success: true,
          product_id: (createRes.product && createRes.product.id) || createRes.product_id,
          title: p.title || (createRes.product && (createRes.product.name || createRes.product.title)) || 'New Product',
          cost,
          pricing: pricingInfo,
          mockups
        };
        
        results.push(normalized);
        continue;
      }

      const mockups = mockupRes.urls || mockupRes.mockups || [];
      console.log(`[pricing-orchestrator] Successfully got mockups:`, mockups.length, 'mockups');
      console.log(`[pricing-orchestrator] Mockup URLs:`, mockups.map(m => m.url).join(', '));
      
      // 3. Get pricing information using the proxy to ensure consistent auth
      let hasPricingError = false;
      try {
        console.log(`[pricing-orchestrator] Getting pricing for product ${p.catalog_product_id} via proxy`);

        const pricingRes = await fetch(`${baseUrl}/.netlify/functions/printful-proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({
            endpoint: `/v2/catalog-products/${p.catalog_product_id}/pricing`,
            method: 'GET'
          })
        });

        console.log(`[pricing-orchestrator] Pricing response status: ${pricingRes.status}`);

        if (pricingRes.ok) {
          const proxyResponse = await pricingRes.json();
          if (proxyResponse.success) {
            console.log(`[pricing-orchestrator] Pricing data received for ${p.catalog_product_id}:`, JSON.stringify(proxyResponse.data, null, 2));
            pricingInfo = proxyResponse.data.data || proxyResponse.data;

            // Calculate cost from pricing info
            if (pricingInfo && pricingInfo.variants && pricingInfo.variants.length > 0) {
              const firstVariant = pricingInfo.variants[0];
              cost = parseFloat(firstVariant.cost) || 0;
              console.log(`[pricing-orchestrator] Cost calculated: $${cost}`);
            } else {
              console.warn(`[pricing-orchestrator] No variants found in pricing data for ${p.catalog_product_id}`);
              // Try to extract cost from v1 format if present
              if (pricingInfo && pricingInfo.cost) {
                cost = parseFloat(pricingInfo.cost) || 0;
              }
            }
          } else {
            console.warn(`[pricing-orchestrator] Proxy returned error for pricing ${p.catalog_product_id}:`, proxyResponse.error);
            hasPricingError = true;
          }
        } else {
          const errorText = await pricingRes.text();
          console.warn(`[pricing-orchestrator] Could not get pricing for ${p.catalog_product_id}:`, pricingRes.status, errorText);
          hasPricingError = true;
        }
      } catch (pricingError) {
        console.warn(`[pricing-orchestrator] Pricing fetch error for ${p.catalog_product_id}:`, pricingError.message);
        hasPricingError = true;
      }

      const normalized = {
        success: true,
        product_id: (createRes.product && createRes.product.id) || createRes.product_id,
        title: p.title || (createRes.product && (createRes.product.name || createRes.product.title)) || 'New Product',
        cost,
        pricing: pricingInfo,
        mockups,
        pricing_error: hasPricingError
      };
      results.push(normalized);
      console.log(`[pricing-orchestrator] Final result for ${p.catalog_product_id}:`, JSON.stringify(normalized, null, 2));

    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, products: results }) };
  } catch (err) {
    console.error('[pricing-orchestrator] Unhandled error:', err);
    return { 
      statusCode: 500, 
      headers: corsHeaders, 
      body: JSON.stringify({ 
        success: false, 
        error: err.message || 'Internal server error',
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }) 
    };
  }
};