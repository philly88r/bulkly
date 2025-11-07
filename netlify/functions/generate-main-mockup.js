// netlify/functions/generate-main-mockup.js
const fetch = require('node-fetch');

// --- API Call Helper ---
async function makePrintfulApiCall(endpoint, options = {}, event) {
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
    const proxyUrl = `${siteUrl || `http://${event.headers.host}`}/.netlify/functions/printful-proxy`;
    const authHeader = event.headers.authorization || '';
    const forward = { endpoint, method: options.method || 'GET', body: options.body || null, headers: options.headers || {} };

    const resp = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) },
        body: JSON.stringify(forward)
    });

    const json = await resp.json();
    if (!resp.ok) {
        const detail = (json?.details?.body?.error) || JSON.stringify(json, null, 2);
        console.error(`[generate-main-mockup] API call to ${endpoint} failed: ${resp.status}`, detail);
        throw new Error(`Printful API error: ${detail}`);
    }
    return json;
}

// --- Helper Functions (adapted from frontend) ---

async function getV2PlacementTechniqueMap(catalogProductId, event) {
    try {
        const res = await makePrintfulApiCall(`/v2/catalog-products/${catalogProductId}/mockup-styles?default_mockup_styles=true`, { headers: { 'X-PF-Language': 'en' } }, event);
        const data = res?.data?.data ?? [];
        const map = new Map();
        data.forEach(it => {
            const placement = String(it?.placement || '').trim().toLowerCase();
            const technique = String(it?.technique || '').trim().toLowerCase();
            if (placement && technique) map.set(placement, technique);
        });
        return { techniqueByPlacement: map };
    } catch (e) {
        console.error('getV2PlacementTechniqueMap failed', e);
        return { techniqueByPlacement: new Map() };
    }
}

async function getV2ProductOptionNames(catalogProductId, event) {
    try {
        const res = await makePrintfulApiCall(`/mockup-generator/printfiles/${Number(catalogProductId)}`, {}, event);
        const groups = res?.result?.option_groups || [];
        const names = new Set();
        const scanNode = (node) => {
            if (!node || typeof node !== 'object') return;
            const key = String(node.key || node.name || node.id || '').trim().toLowerCase().replace(/\s+/g, '_');
            if (key) names.add(key);
            if (Array.isArray(node.options)) node.options.forEach(scanNode);
        };
        groups.forEach(scanNode);
        return { optionNames: names };
    } catch (e) {
        console.error('getV2ProductOptionNames failed', e);
        return { optionNames: new Set() };
    }
}

async function fetchCatalogVariantIds(catalogProductId, event) {
    try {
        const pf = await makePrintfulApiCall(`/mockup-generator/printfiles/${Number(catalogProductId)}`, {}, event);
        const ids = (pf?.result?.variant_printfiles || []).map(e => e?.variant_id).filter(Boolean).map(Number);
        return ids.length ? ids : [];
    } catch (e) {
        console.warn('fetchCatalogVariantIds error', e);
        return [];
    }
}

async function pollV2MockupTask(taskId, event, { timeoutMs = 240000, intervalMs = 3000 }) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, intervalMs));
        const res = await makePrintfulApiCall(`/v2/mockup-tasks?id=${taskId}`, {}, event);
        const task = res?.data?.data?.[0] || {};
        const status = String(task.status || '').toLowerCase();
        if (status === 'completed') return task;
        if (status === 'failed') throw new Error(`Mockup task ${taskId} failed: ${JSON.stringify(task.failure_reasons)}`);
    }
    throw new Error(`Mockup task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

async function createMockupGenerationTask(payload, event) {
    console.log('[MOCKUPS] Creating mockup task with payload:', JSON.stringify(payload, null, 2));
    let taskResponse;
    try {
        taskResponse = await makePrintfulApiCall('/v2/mockup-tasks', { method: 'POST', body: payload }, event);
    } catch (err) {
        // Handle rate limiting - return pending for client to retry
        if (/rate limit|too many requests|429/i.test(err.message)) {
            console.warn('[MOCKUPS] Rate limit detected. Returning pending for client retry.');
            return { pending: true, rate_limited: true, retry_payload: payload };
        }
        
        // Retry logic for stitch_color
        if (/stitch_color/i.test(err.message)) {
            console.warn('[MOCKUPS] Missing stitch_color detected. Retrying with default value.');
            const patched = JSON.parse(JSON.stringify(payload));
            patched.products[0].product_options = patched.products[0].product_options || [];
            patched.products[0].product_options.push({ name: 'stitch_color', value: 'black' });
            taskResponse = await makePrintfulApiCall('/v2/mockup-tasks', { method: 'POST', body: patched }, event);
        } else if (/style_ids.*are not available/i.test(err.message)) {
            console.warn('[MOCKUPS] Style ID mismatch detected. Adding compatible style IDs and retrying.');
            const patched = JSON.parse(JSON.stringify(payload));
            // Extract available style IDs from error message
            const match = err.message.match(/Available.*?style_ids.*?are:\s*([0-9,\s]+)/i);
            if (match) {
                const availableStyles = match[1].split(',').map(s => parseInt(s.trim())).filter(Boolean);
                console.log('[MOCKUPS] Using available style IDs:', availableStyles.slice(0, 3)); // Use first 3
                patched.products[0].mockup_style_ids = availableStyles.slice(0, 3);
            }
            taskResponse = await makePrintfulApiCall('/v2/mockup-tasks', { method: 'POST', body: patched }, event);
        } else {
            throw err;
        }
    }

    const taskId = taskResponse?.data?.data?.[0]?.id;
    if (!taskId) throw new Error('No task ID returned from mockup creation');

    console.log(`[MOCKUPS] Task ${taskId} created. Polling for completion...`);
    const result = await pollV2MockupTask(taskId, event, {});

    const mockupUrls = [];
    (result?.catalog_variant_mockups || []).forEach(variantMockup => {
        (variantMockup?.mockups || []).forEach(mockup => {
            if (mockup.mockup_url) mockupUrls.push(mockup.mockup_url);
        });
    });

    console.log('[MOCKUPS] Generated', mockupUrls.length, 'mockup URLs');
    return Array.from(new Set(mockupUrls)); // Return deduped URLs
}


// --- Main Handler ---

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { product } = JSON.parse(event.body);
        if (!product || !product._productData) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid product data provided.' }) };
        }

        const { _productData } = product;
        const catalogProductId = Number(_productData.catalog_product_id);

        const { techniqueByPlacement } = await getV2PlacementTechniqueMap(catalogProductId, event);
        const { optionNames } = await getV2ProductOptionNames(catalogProductId, event);

        const product_options = [];
        if (optionNames.has('stitch_color')) {
            product_options.push({ name: 'stitch_color', value: 'black' }); // Default to black
        }

        let catalog_variant_ids = (_productData.selected_variant_ids || []).map(Number).filter(Boolean);
        if (!catalog_variant_ids.length) {
            catalog_variant_ids = await fetchCatalogVariantIds(catalogProductId, event);
        }
        if (!catalog_variant_ids.length) {
            throw new Error(`No variant IDs found for product ${catalogProductId}`);
        }

        const mockupPayload = {
            format: 'png',
            products: [{
                source: 'catalog',
                catalog_product_id: catalogProductId,
                catalog_variant_ids,
                placements: _productData.placement_files.map(pf => {
                    const plc = String(pf.placement || 'front').toLowerCase();
                    const tech = techniqueByPlacement.get(plc);
                    if (!tech) {
                        console.warn(`[MOCKUPS] No technique for placement '${plc}'. Skipping.`);
                        return null;
                    }
                    return {
                        placement: plc,
                        technique: tech,
                        layers: [{ type: 'file', url: pf.image_url }]
                    };
                }).filter(Boolean),
                ...(product_options.length ? { product_options } : {})
            }]
        };
        
        const result = await createMockupGenerationTask(mockupPayload, event);

        // Handle pending/rate-limited responses
        if (result && result.pending) {
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    success: true, 
                    pending: true, 
                    rate_limited: result.rate_limited || false,
                    retry_payload: result.retry_payload 
                })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, mockupUrls: result })
        };

    } catch (error) {
        console.error('[generate-main-mockup] Unhandled Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};