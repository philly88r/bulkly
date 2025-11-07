const fetch = require('node-fetch');

// Normalize styles from various API response shapes into a flat array of style objects
function normalizeStyles(input) {
  try {
    if (!input) return [];
    // If the input is already an array of groups with mockup_styles
    if (Array.isArray(input)) {
      if (input.length && input[0] && Array.isArray(input[0].mockup_styles)) {
        return input.flatMap(g => Array.isArray(g.mockup_styles) ? g.mockup_styles : []);
      }
      // If it's an array of style objects
      if (input.length && input[0] && (input[0].id || input[0].mockup_style_id)) {
        return input;
      }
      return [];
    }
    // If it's a single object with mockup_styles
    if (input && Array.isArray(input.mockup_styles)) {
      return input.mockup_styles;
    }
    return [];
  } catch {
    return [];
  }
}

// Helper: extract an array from common API response envelope shapes
function arrayFromResponse(res) {
  // Unwrap proxy success envelope if present
  if (res && res.success === true && 'data' in res) {
    res = res.data;
  }
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.result)) return res.result;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

// Helper: unwrap proxy envelope { success, data }
function unwrapProxyResponse(res) {
  try {
    if (res && res.success === true && 'data' in res) return res.data;
  } catch {}
  return res;
}

// Helper: call our printful-proxy so we use the user's OAuth token.
// We forward the caller's Authorization header (app JWT) to the proxy.
async function makeProxyCall(event, endpoint, options = {}) {
  const { method = 'GET', headers = {}, body } = options;
  // Build absolute URL to our proxy. Prefer Netlify-provided URL vars, else derive from headers.
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  let proxyUrl = '';
  if (siteUrl) {
    proxyUrl = `${siteUrl}/.netlify/functions/printful-proxy`;
  } else {
    const proto = (event.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = event.headers.host;
    proxyUrl = `${proto}://${host}/.netlify/functions/printful-proxy`;
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';

  const forward = {
    endpoint, // e.g. '/v2/catalog-products/xxx/mockup-styles'
    method,
    body: body || null,
    headers // forwarded to Printful
  };

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {})
    },
    body: JSON.stringify(forward)
  };

  // Simple retry with exponential backoff for 429/5xx
  const maxRetries = 7;
  let attempt = 0;
  
  while (attempt <= maxRetries) {
    attempt++;
    console.log(`[PROXY] Attempt ${attempt}/${maxRetries + 1} for ${endpoint}`);
    
    try {
      const res = await fetch(proxyUrl, fetchOptions);
      const raw = await res.text();
      let json;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch (parseErr) {
        json = null;
      }
      console.log(`[PROXY] Response ${res.status} for ${endpoint}:`, json ?? raw ?? '(empty)');

      if (res.ok) {
        if (json && typeof json === 'object') {
          // Return full proxy JSON so callers can access res?.data consistently
          return json;
        }
        throw new Error(`HTTP ${res.status}: Empty or invalid JSON response from proxy`);
      }
      
      // Handle rate limiting and server errors with retry
      if ((res.status === 429 || res.status >= 500) && attempt <= maxRetries) {
        const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000); // Longer exponential backoff, max 60s
        console.log(`[PROXY] Rate limited or server error, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // If we get here, it's a non-retryable error or we've exhausted retries
      const errMsg = (json && json.error) ? json.error : (raw || 'Unknown error');
      throw new Error(`HTTP ${res.status}: ${errMsg}`);
      
    } catch (fetchError) {
      console.error(`[PROXY] Fetch error on attempt ${attempt}:`, fetchError);
      // Do not retry client errors (4xx) except 429
      const msg = (fetchError && fetchError.message) || '';
      if (/HTTP\s+4\d{2}/.test(msg) && !/HTTP\s+429/.test(msg)) {
        throw fetchError;
      }

      if (attempt <= maxRetries) {
        const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
        console.log(`[PROXY] Network error, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      throw fetchError;
    }
  }
}

exports.handler = async (event, context) => {
  console.log('[MOCKUP-GALLERY] Function invoked');
  console.log('[MOCKUP-GALLERY] Event method:', event.httpMethod);
  console.log('[MOCKUP-GALLERY] Event body:', event.body);
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    console.log('[MOCKUP-GALLERY] Handling OPTIONS request');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    console.log('[MOCKUP-GALLERY] Parsing request body...');
    const requestBody = JSON.parse(event.body);
    console.log('[MOCKUP-GALLERY] Parsed body:', JSON.stringify(requestBody, null, 2));
    
    const { catalog_product_id, placement_files, catalog_variant_ids: reqVariantIds, product_options: reqProductOptions, technique: reqTechnique, style_id: reqStyleId } = requestBody;
    // Desired mockup count (default 10, clamp 1..12)
    const desiredCount = (() => {
      const v = Number(requestBody.count ?? requestBody.desired_count);
      if (!isFinite(v) || v <= 0) return 12;
      return Math.max(1, Math.min(16, Math.round(v)));
    })();
    
    console.log('[MOCKUP-GALLERY] Extracted parameters:');
    console.log('  - catalog_product_id:', catalog_product_id);
    console.log('  - placement_files:', placement_files?.length || 0, 'files');
    console.log('  - request catalog_variant_ids:', Array.isArray(reqVariantIds) ? reqVariantIds : 'none');
    console.log('  - desiredCount:', desiredCount);
    console.log('  - technique:', reqTechnique || 'auto-detect');
    console.log('  - style_id:', reqStyleId || 'auto-select');
    if (Array.isArray(reqProductOptions)) {
      console.log('  - provided product_options:', reqProductOptions);
    }
    
    if (!catalog_product_id || !placement_files) {
      console.error('[MOCKUP-GALLERY] Missing required parameters');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Missing catalog_product_id or placement_files',
          received: { catalog_product_id, placement_files: placement_files?.length }
        })
      };
    }

    const apiHeaders = {};
    console.log('[MOCKUP-GALLERY] Using account-level OAuth (no X-PF-Store-Id header).');
    
    console.log('[MOCKUP-GALLERY] Starting mockup generation for product:', catalog_product_id);

    // Step 1: Get mockup styles (try multiple permutations to maximize diversity)
    console.log('[MOCKUP-GALLERY] Fetching mockup styles (expanded permutations)...');

    // Simplified: try only 2 most likely endpoints to reduce timeout risk
    const urls = [
      `/v2/catalog-products/${catalog_product_id}/mockup-styles?default_mockup_styles=true&limit=50`,
      `/v2/catalog-products/${catalog_product_id}/mockup-styles?limit=50`
    ];

    let rawStyles = [];
    for (const u of urls) {
      try {
        const resRaw = await makeProxyCall(event, u, { headers: apiHeaders });
        const res = unwrapProxyResponse(resRaw);
        console.log('[MOCKUP-GALLERY] Styles response for', u, '- count:', arrayFromResponse(res).length);
        const normalized = normalizeStyles(arrayFromResponse(res));
        rawStyles.push(...normalized);
        if (rawStyles.length >= 40) break; // Stop early if we have enough for larger galleries
      } catch (e) {
        console.warn('[MOCKUP-GALLERY] Styles fetch failed for', u, e.message);
      }
    }
    // Dedupe by id
    const seen = new Set();
    rawStyles = rawStyles.filter(s => {
      const id = s && (s.id ?? s.mockup_style_id);
      if (!id) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    // Wrap into a single group compatible with selectDiverseStyles
    const styles = [{ mockup_styles: rawStyles }];
    console.log('[MOCKUP-GALLERY] Combined unique styles count:', rawStyles.length);

    // Detect if any style implies embroidery technique; this informs required product_options
    const requiresEmbroidery = (() => {
      try {
        return rawStyles.some(s => {
          const t = String(s?.technique || s?.technique_name || '').toLowerCase();
          const cat = String(s?.category || s?.category_name || '').toLowerCase();
          const view = String(s?.view || s?.view_name || '').toLowerCase();
          return t === 'embroidery' || /embroider/.test(cat) || /embroider/.test(view);
        });
      } catch { return false; }
    })();
    console.log('[MOCKUP-GALLERY] requiresEmbroidery:', requiresEmbroidery);

    if (!styles.length) {
      console.warn('[MOCKUP-GALLERY] No styles found, returning fallback');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false, 
          message: 'No mockup styles available for this product',
          fallback_templates: []
        })
      };
    }

    // Step 2: Resolve product variants
    let variantIds = Array.isArray(reqVariantIds) ? reqVariantIds.map(v => parseInt(v, 10)).filter(Boolean) : [];
    if (variantIds.length) {
      console.log('[MOCKUP-GALLERY] Using client-provided catalog_variant_ids:', variantIds);
    }

    if (!variantIds.length) {
      // Use OAuth-friendly printfiles endpoint to infer catalog_variant_ids
      try {
        console.log('[MOCKUP-GALLERY] Resolving variants via mockup-generator/printfiles...');
        const pfRaw = await makeProxyCall(event, `/mockup-generator/printfiles/${catalog_product_id}`, { headers: apiHeaders });
        const pf = unwrapProxyResponse(pfRaw);
        const vmap = Array.isArray(pf?.data?.variant_printfiles) ? pf.data.variant_printfiles
                   : Array.isArray(pf?.result?.variant_printfiles) ? pf.result.variant_printfiles
                   : Array.isArray(pf?.variant_printfiles) ? pf.variant_printfiles
                   : [];
        variantIds = (Array.isArray(vmap) ? vmap : [])
          .map(e => e?.variant_id || e?.catalog_variant_id)
          .filter(Boolean)
          .map(v => parseInt(v, 10))
          .filter(Boolean);
        console.log('[MOCKUP-GALLERY] Variant IDs from printfiles:', variantIds);
      } catch (e) {
        console.warn('[MOCKUP-GALLERY] printfiles variant resolution failed:', e.message);
      }
    }

    // If still none, query the dedicated catalog-variants endpoint
    if (!variantIds.length) {
      try {
        console.log('[MOCKUP-GALLERY] Fetching catalog-variants endpoint...');
        const vRes = await makeProxyCall(
          event,
          `/v2/catalog-products/${catalog_product_id}/catalog-variants?limit=100`,
          { headers: apiHeaders }
        );
        const vArr = arrayFromResponse(vRes);
        variantIds = (Array.isArray(vArr) ? vArr : [])
          .map(v => v?.id ?? v?.variant_id ?? v?.catalog_variant_id)
          .filter(Boolean);
        console.log('[MOCKUP-GALLERY] Variant IDs from catalog-variants endpoint:', variantIds);
      } catch (e) {
        console.warn('[MOCKUP-GALLERY] catalog-variants fetch failed:', e.message);
      }
    }

    // Step 2.1: Try variant images to harvest additional style_ids
    try {
      if (variantIds && variantIds.length) {
        console.log('[MOCKUP-GALLERY] Fetching variant images for style discovery from variant', variantIds[0]);
        const imgResRaw = await makeProxyCall(
          event,
          `/v2/catalog-variants/${variantIds[0]}/images?limit=100`,
          { headers: apiHeaders }
        );
        const imgRes = unwrapProxyResponse(imgResRaw);
        console.log('[MOCKUP-GALLERY] Variant images API response:', JSON.stringify(imgRes, null, 2));
        const imagesArr = arrayFromResponse(imgRes);
        let added = 0;
        imagesArr.forEach(vimg => {
          const imgs = Array.isArray(vimg?.images) ? vimg.images : [];
          imgs.forEach(im => {
            const sid = im?.style_id || im?.mockup_style_id;
            if (sid) {
              // Push a minimal style placeholder so selection can include it
              rawStyles.push({ id: sid, category_name: im?.category_name || im?.style_name || '', view_name: im?.view_name || im?.view || '' });
              added++;
            }
          });
        });
        console.log('[MOCKUP-GALLERY] Harvested additional styles from variant images:', added);
      }
    } catch (e) {
      console.warn('[MOCKUP-GALLERY] Variant images discovery failed:', e.message);
    }

    if (!variantIds.length) {
      console.error('[MOCKUP-GALLERY] No variants found for product', catalog_product_id);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'No catalog variants found for product.' })
      };
    }

    // Step 3: Select diverse mockup styles (models, flat, lifestyle, etc.)
    console.log('[MOCKUP-GALLERY] Selecting diverse styles...');
    let selectedStyles;

    // If a specific style_id was provided, prioritize it
    if (reqStyleId) {
      console.log('[MOCKUP-GALLERY] Using provided style_id:', reqStyleId);
      selectedStyles = [reqStyleId];
      // Add more diverse styles if we need more than one
      if (desiredCount > 1) {
        const diverseStyles = selectDiverseStyles(styles, desiredCount - 1);
        selectedStyles.push(...diverseStyles.filter(id => id !== reqStyleId));
      }
    } else {
      selectedStyles = selectDiverseStyles(styles, desiredCount);
    }

    console.log('[MOCKUP-GALLERY] Selected', selectedStyles.length, 'styles:', selectedStyles);

    // Step 3.5: Product options and technique map
    // Get proper technique mapping for this specific product
    let productOptions = Array.isArray(reqProductOptions) ? reqProductOptions.filter(o => o && o.name && (o.value !== undefined)).map(o => ({ name: String(o.name), value: String(o.value) })) : [];
    let placementTechniqueMap = new Map();
    
    // Fetch technique map for this specific catalog product
    try {
      const techniqueRes = await makeProxyCall(`/v2/catalog-products/${catalog_product_id}/mockup-styles?default_mockup_styles=true`, { headers: { 'X-PF-Language': 'en' } }, event);
      const techniqueData = arrayFromResponse(unwrapProxyResponse(techniqueRes));
      techniqueData.forEach(it => {
        const placement = String(it?.placement || '').trim().toLowerCase();
        const technique = String(it?.technique || '').trim().toLowerCase();
        if (placement && technique) placementTechniqueMap.set(placement, technique);
      });
      console.log('[MOCKUP-GALLERY] Technique map for product', catalog_product_id, ':', Array.from(placementTechniqueMap.entries()));
    } catch (e) {
      console.warn('[MOCKUP-GALLERY] Failed to fetch technique map:', e);
    }

    // Check if product requires stitch_color (for cut-sew products)
    try {
      const printfileRes = await makeProxyCall(`/mockup-generator/printfiles/${catalog_product_id}`, {}, event);
      const groups = printfileRes?.data?.result?.option_groups || [];
      const hasStitchColor = groups.some(group => 
        group?.key?.toLowerCase().includes('stitch') || 
        group?.name?.toLowerCase().includes('stitch')
      );
      if (hasStitchColor && !productOptions.some(opt => opt.name === 'stitch_color')) {
        productOptions.push({ name: 'stitch_color', value: 'black' });
        console.log('[MOCKUP-GALLERY] Added stitch_color option for product', catalog_product_id);
      }
    } catch (e) {
      console.warn('[MOCKUP-GALLERY] Failed to check for stitch_color requirement:', e);
    }
    // Proactively add stitch_color if embroidery is required and not already provided
    try {
      const hasStitch = productOptions.some(o => String(o?.name).toLowerCase() === 'stitch_color');
      if (requiresEmbroidery && !hasStitch) {
        productOptions.push({ name: 'stitch_color', value: 'black' });
        console.log('[MOCKUP-GALLERY] Added default product_option stitch_color=black due to embroidery requirement');
      }
    } catch {}

    // Step 4: Get design file dimensions for dynamic sizing
    let designWidth = null;
    try {
      if (placement_files.length > 0 && placement_files[0].url) {
        const imageResponse = await fetch(placement_files[0].url);
        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.arrayBuffer();
          const sharp = require('sharp');
          const metadata = await sharp(Buffer.from(imageBuffer)).metadata();
          designWidth = metadata.width;
          console.log('[MOCKUP-GALLERY] Design file width:', designWidth);
        }
      }
    } catch (e) {
      console.warn('[MOCKUP-GALLERY] Could not get design dimensions:', e.message);
    }

    // Step 5: Create mockup task with dynamic sizing
    console.log('[MOCKUP-GALLERY] Building mockup payload...');
    const mockupPayload = {
      format: 'png',
      // Use actual design width - no hardcoded sizes
      ...(designWidth && { width: designWidth }),
      products: [{
        source: 'catalog',
        catalog_product_id: parseInt(catalog_product_id, 10),
        // Use only one representative variant to avoid duplicate-looking results and reduce API load
        catalog_variant_ids: [variantIds[0]],
        mockup_style_ids: selectedStyles,
        placements: placement_files.map(pf => {
          const plc = String(pf.placement || 'front').toLowerCase();

          // Determine technique priority: passed technique > file technique > placement map > embroidery detection > default
          let technique;
          if (reqTechnique) {
            technique = reqTechnique;
            console.log(`[MOCKUP-GALLERY] Using provided technique: ${technique}`);
          } else if (pf.technique) {
            technique = pf.technique;
            console.log(`[MOCKUP-GALLERY] Using file technique: ${technique}`);
          } else if (placementTechniqueMap.has(plc)) {
            technique = placementTechniqueMap.get(plc);
            console.log(`[MOCKUP-GALLERY] Using mapped technique for ${plc}: ${technique}`);
          } else if (requiresEmbroidery) {
            technique = 'embroidery';
            console.log(`[MOCKUP-GALLERY] Using embroidery (detected from styles)`);
          } else {
            technique = 'sublimation';
            console.log(`[MOCKUP-GALLERY] Using default technique: sublimation`);
          }

          console.log(`[MOCKUP-GALLERY] Final placement "${plc}" using technique "${technique}"`);

          return {
            placement: plc,
            technique,
            layers: [{ type: 'file', url: pf.image_url || pf.url }]
          };
        }),
        ...(productOptions.length ? { product_options: productOptions } : {})
      }]
    };

    console.log('[MOCKUP-GALLERY] Creating task with payload:', JSON.stringify(mockupPayload, null, 2));

    // Attempt task creation; if missing required product option (e.g., stitch_color), retry with defaults
    let taskResRaw;
    let taskRes;
    try {
      taskResRaw = await makeProxyCall(event, '/v2/mockup-tasks', {
        method: 'POST',
        headers: apiHeaders,
        body: mockupPayload
      });
      taskRes = unwrapProxyResponse(taskResRaw);
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : '';
      
      // Check if this is a rate limit error - return pending immediately
      const isRateLimit = /rate limit/i.test(msg) || /429/i.test(msg) || /TooManyRequests/i.test(msg);
      
      if (isRateLimit) {
        console.log('[MOCKUP-GALLERY] Hit rate limit during task creation, returning pending for client polling');
        // Return pending immediately - don't wait for rate limits in server function
        const response = {
          success: true,
          pending: true,
          task_id: null, // No task created yet
          rate_limited: true,
          poll_after_ms: 30000, // Wait 30s before retrying
          poll_url: '/.netlify/functions/poll-mockup-task',
          retry_payload: mockupPayload // Include payload for retry
        };
        return { statusCode: 200, headers, body: JSON.stringify(response) };
      }
      
      // Retry if error mentions stitch_color OR generic 400 while embroidery is inferred OR product_options lack stitch_color
      const initialHasStitch = Array.isArray(productOptions) && productOptions.some(o => String(o?.name).toLowerCase() === 'stitch_color');
      const isHttp400 = /HTTP\s+400/i.test(msg) || /BadRequest/i.test(msg);
      const mentionsStitch = /stitch_color/i.test(msg);
      const shouldRetry = (!initialHasStitch) && (mentionsStitch || (requiresEmbroidery && isHttp400));

      if (shouldRetry) {
        console.log('[MOCKUP-GALLERY] Retrying with injected stitch_color due to', mentionsStitch ? 'explicit stitch_color error' : 'embroidery + 400');
        try {
          const patched = JSON.parse(JSON.stringify(mockupPayload));
          if (patched && Array.isArray(patched.products) && patched.products[0]) {
            const p0 = patched.products[0];
            p0.product_options = Array.isArray(p0.product_options) ? p0.product_options : [];
            const hasStitch = p0.product_options.some(o => String(o?.name).toLowerCase() === 'stitch_color');
            if (!hasStitch) p0.product_options.push({ name: 'stitch_color', value: 'black' });
          }
          console.log('[MOCKUP-GALLERY] Retrying task creation with product_options:', JSON.stringify(patched.products[0].product_options || [], null, 2));
          taskResRaw = await makeProxyCall(event, '/v2/mockup-tasks', {
            method: 'POST',
            headers: apiHeaders,
            body: patched
          });
          taskRes = unwrapProxyResponse(taskResRaw);
        } catch (retryErr) {
          console.warn('[MOCKUP-GALLERY] Retry with stitch_color failed:', retryErr.message || retryErr);
          throw err;
        }
      } else {
        throw err;
      }
    }

    console.log('[MOCKUP-GALLERY] Task creation response (raw):', JSON.stringify(taskResRaw, null, 2));
    console.log('[MOCKUP-GALLERY] Task creation response (unwrapped):', JSON.stringify(taskRes, null, 2));

    const taskId = extractTaskId(taskRes);
    console.log('[MOCKUP-GALLERY] Extracted task ID:', taskId);
    
    if (!taskId) {
      console.error('[MOCKUP-GALLERY] Failed to extract task ID from response');
      throw new Error('Failed to create mockup task - no task ID returned');
    }

    console.log('[MOCKUP-GALLERY] Task created successfully:', taskId);

    // Step 5: Poll for completion (with timeout)
    console.log('[MOCKUP-GALLERY] Starting polling for task completion (short)...');
    let completedTask = null;
    let pending = false;
    try {
      // Short poll only (<= 10s) to avoid Netlify 30s function timeout across busy accounts
      completedTask = await pollMockupTask(event, taskId, apiHeaders, 10000);
    } catch (e) {
      // If timeout/long-running, return pending to let client poll via lightweight endpoint
      console.log('[MOCKUP-GALLERY] Short poll did not complete:', e?.message || e);
      pending = true;
    }

    if (pending || !completedTask) {
      const response = {
        success: true,
        pending: true,
        task_id: taskId,
        poll_after_ms: 3000,
        poll_url: '/.netlify/functions/poll-mockup-task'
      };
      return { statusCode: 200, headers, body: JSON.stringify(response) };
    }

    console.log('[MOCKUP-GALLERY] Polling completed. Task data:', JSON.stringify(completedTask, null, 2));

    // Step 6: Extract and return mockup URLs
    console.log('[MOCKUP-GALLERY] Extracting mockup URLs...');
    let mockupUrls = extractMockupUrls(completedTask);
    // Dedupe by URL
    const seenUrls = new Set();
    mockupUrls = mockupUrls.filter(m => {
      if (!m || !m.url) return false;
      if (seenUrls.has(m.url)) return false;
      seenUrls.add(m.url);
      return true;
    });
    
    console.log('[MOCKUP-GALLERY] Extracted (deduped)', mockupUrls.length, 'mockup URLs');
    
    const response = {
      success: true,
      pending: false,
      task_id: taskId,
      urls: mockupUrls
    };
    return { statusCode: 200, headers, body: JSON.stringify(response) };

  } catch (error) {
    console.error('[MOCKUP-GALLERY] Error occurred:', error);
    console.error('[MOCKUP-GALLERY] Error stack:', error.stack);
    
    const errorResponse = { 
      error: error.message,
      success: false,
      stack: error.stack
    };
    
    console.log('[MOCKUP-GALLERY] Returning error response:', JSON.stringify(errorResponse, null, 2));
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify(errorResponse)
    };
  }
};

// Select diverse mockup styles (models, flat, lifestyle, etc.)
function selectDiverseStyles(styleGroups, desiredCount = 12) {
  try {
    console.log('[MOCKUP-GALLERY] selectDiverseStyles called. desiredCount =', desiredCount);
    const maxCount = Math.max(1, Math.min(16, Number(desiredCount) || 12));

    const selectedIds = [];
    const seen = new Set();
    const pickedCategories = new Set();

    // Flatten styles
    const allStyles = [];
    (styleGroups || []).forEach((group, groupIndex) => {
      const arr = Array.isArray(group?.mockup_styles) ? group.mockup_styles : [];
      arr.forEach(s => {
        const id = s && (s.id ?? s.mockup_style_id);
        if (!id || seen.has(id)) return;
        seen.add(id);
        allStyles.push({
          id,
          category: s.category_name || s.style_category || 'Unknown',
          view_name: s.view_name || s.view || '',
          priority: 0,
        });
      });
    });

    console.log('[MOCKUP-GALLERY] Total unique styles available:', allStyles.length);
    if (!allStyles.length) return [];

    // Category priorities for diversity
    const priorityCategories = ['Flat', 'Model', 'Lifestyle', "Couple's", 'Scene'];

    // First pass: pick one from each priority category
    for (const cat of priorityCategories) {
      if (selectedIds.length >= maxCount) break;
      const candidate = allStyles.find(s => s.category === cat && !selectedIds.includes(s.id));
      if (candidate) {
        selectedIds.push(candidate.id);
        pickedCategories.add(cat);
      }
    }

    // Second pass: fill up remaining with other categories, prefer unseen categories
    for (const s of allStyles) {
      if (selectedIds.length >= maxCount) break;
      if (selectedIds.includes(s.id)) continue;
      if (!pickedCategories.has(s.category)) {
        selectedIds.push(s.id);
        pickedCategories.add(s.category);
      }
    }

    // Final pass: if still short, just add anything until we hit the cap
    for (const s of allStyles) {
      if (selectedIds.length >= maxCount) break;
      if (!selectedIds.includes(s.id)) selectedIds.push(s.id);
    }

    const result = selectedIds.slice(0, maxCount);
    console.log('[MOCKUP-GALLERY] Selected style IDs:', result);
    console.log('[MOCKUP-GALLERY] Selected categories:', Array.from(pickedCategories));
    return result;
  } catch (e) {
    console.warn('[MOCKUP-GALLERY] selectDiverseStyles error:', e?.message);
    return [];
  }
}

// Extract task ID from various response formats
function extractTaskId(response) {
  try {
    // Unwrap proxy envelope if needed
    if (response && response.success === true && 'data' in response) response = response.data;
    // Common shapes
    if (Array.isArray(response?.data) && response.data[0]?.id) return response.data[0].id;
    if (response?.data?.id) return response.data.id;
    if (response?.id) return response.id;
    // Some APIs use 'result'
    if (Array.isArray(response?.result) && response.result[0]?.id) return response.result[0].id;
    if (response?.result?.id) return response.result.id;
    // Extremely defensive: search shallow for numeric id
    for (const k of ['task_id', 'mockup_task_id']) {
      const v = response?.[k] ?? response?.data?.[k] ?? response?.result?.[k];
      if (v) return v;
    }
  } catch {}
  return null;
}

// Poll mockup task with exponential backoff
async function pollMockupTask(event, taskId, headers, maxWaitMs = 120000) {
  console.log('[MOCKUP-GALLERY] Starting polling for task:', taskId);
  console.log('[MOCKUP-GALLERY] Max wait time:', maxWaitMs, 'ms');
  
  const startTime = Date.now();
  let delay = 3000; // Start with 3 seconds
  let pollCount = 0;
  
  while (Date.now() - startTime < maxWaitMs) {
    pollCount++;
    console.log(`[MOCKUP-GALLERY] Poll attempt ${pollCount} for task ${taskId}`);
    
    try {
      const responseRaw = await makeProxyCall(event, `/v2/mockup-tasks?id=${taskId}`, { headers });
      console.log(`[MOCKUP-GALLERY] Poll ${pollCount} response:`, JSON.stringify(responseRaw, null, 2));
      const response = unwrapProxyResponse(responseRaw);
      
      // Normalize to task object
      let taskData = null;
      if (Array.isArray(response?.data)) taskData = response.data[0];
      else if (Array.isArray(response?.result)) taskData = response.result[0];
      else if (Array.isArray(response?.items)) taskData = response.items[0];
      else if (Array.isArray(response)) taskData = response[0];
      else if (Array.isArray(response?.data?.data)) taskData = response.data.data[0];
      
      if (!taskData) {
        console.error('[MOCKUP-GALLERY] No task data in response');
        throw new Error('Task not found in response');
      }
      
      console.log(`[MOCKUP-GALLERY] Poll ${pollCount} status:`, taskData.status);
      
      if (taskData.status === 'completed') {
        console.log(`[MOCKUP-GALLERY] Task completed after ${pollCount} polls in ${Date.now() - startTime}ms`);
        return taskData;
      }
      
      if (taskData.status === 'failed') {
        console.error('[MOCKUP-GALLERY] Task failed:', taskData.failure_reasons);
        throw new Error(`Mockup generation failed: ${taskData.failure_reasons?.join(', ') || 'Unknown error'}`);
      }
      
      console.log(`[MOCKUP-GALLERY] Task still ${taskData.status}, waiting ${delay}ms before next poll...`);
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.1, 8000); // Faster backoff, max 8s
      
    } catch (error) {
      console.error(`[MOCKUP-GALLERY] Poll ${pollCount} error:`, error.message);
      
      // If it's a rate limit, wait longer
      if (error.message.includes('429') || error.message.includes('rate')) {
        console.log('[MOCKUP-GALLERY] Rate limited, waiting 30s...');
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        // For other errors, use normal backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.2, 15000);
      }
    }
  }
  
  console.error(`[MOCKUP-GALLERY] Polling timed out after ${pollCount} polls in ${Date.now() - startTime}ms`);
  throw new Error('Mockup generation timed out');
}

// Extract mockup URLs from completed task
function extractMockupUrls(taskData) {
  const urls = [];
  
  if (taskData?.catalog_variant_mockups && Array.isArray(taskData.catalog_variant_mockups)) {
    taskData.catalog_variant_mockups.forEach(variantMockup => {
      if (variantMockup.mockups && Array.isArray(variantMockup.mockups)) {
        variantMockup.mockups.forEach(mockup => {
          if (mockup.mockup_url) {
            urls.push({
              url: mockup.mockup_url,
              placement: mockup.placement,
              technique: mockup.technique,
              style_id: mockup.style_id,
              view: mockup.view,
              display_name: mockup.display_name
            });
          }
        });
      }
    });
  }
  
  return urls;
}

// Fallback: get mockup templates if styles fail
async function getFallbackTemplates(event, catalogProductId, headers) {
  try {
    const templatesRes = await makeProxyCall(
      event,
      `/v2/catalog-products/${catalogProductId}/mockup-templates?limit=20`,
      { headers }
    );
    return arrayFromResponse(templatesRes);
  } catch (error) {
    console.warn('[MOCKUP-GALLERY] Fallback templates failed:', error);
    return [];
  }
}
