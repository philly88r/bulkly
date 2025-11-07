// netlify/functions/generate-main-mockup.js
const fetch = require('node-fetch');

// --- API Call Helper ---
async function makePrintfulApiCall(endpoint, options = {}, event) {
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
    const proxyUrl = `${siteUrl || `http://${event.headers.host}`}/.netlify/functions/printful-proxy`;
    const authHeader = event.headers.authorization || '';

    const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: JSON.stringify({ endpoint, ...options })
    });

    const json = await response.json();
    
    // If response has a 'body' field (Netlify function response), parse it
    if (json.body && typeof json.body === 'string') {
        const parsed = JSON.parse(json.body);
        // Return the parsed body content (which has { success, data, rateLimit })
        return parsed;
    }
    return json;
}

// --- Helper Functions ---

async function getDefaultVariantId(catalogProductId, sellingRegionName, event) {
    try {
        const region = (sellingRegionName || 'usa').toLowerCase();
        console.log(`[MOCKUPS] Fetching default variant for product ${catalogProductId} (region: ${region})`);
        const res = await makePrintfulApiCall(`/v2/catalog-products/${catalogProductId}/catalog-variants?selling_region_name=${region}&limit=1`, {}, event);
        const variantId = res?.data?.data?.[0]?.id;
        if (!variantId) {
            throw new Error('No variants found in API response.');
        }
        console.log(`[MOCKUPS] Found default variant ID: ${variantId}`);
        return variantId;
    } catch (e) {
        console.error(`[MOCKUPS] Could not fetch default variant for ${catalogProductId}:`, e.message);
        throw e;
    }
}

async function pollV2MockupTask(taskId, event, { timeoutMs = 240000, intervalMs = 3000 }) {
    const start = Date.now();
    console.log(`[MOCKUPS] Polling task ${taskId} for up to ${timeoutMs / 1000}s...`);
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const res = await makePrintfulApiCall(`/v2/mockup-tasks?id=${taskId}`, {}, event);
            const task = res?.data?.data?.[0] || {};
            const status = String(task.status || '').toLowerCase();
            console.log(`[MOCKUPS] Task ${taskId} status: ${status}`);
            if (status === 'completed') {
                // Log mockup count
                const mockupCount = (task?.catalog_variant_mockups || []).reduce((count, vm) => {
                    return count + (vm?.mockups || []).length;
                }, 0);
                console.log(`[MOCKUPS] Task ${taskId} completed with ${mockupCount} mockups total`);
                return task;
            }
            if (status === 'failed') throw new Error(`Mockup task ${taskId} failed: ${JSON.stringify(task.failure_reasons)}`);
        } catch (pollError) {
            console.warn(`[MOCKUPS] Poll attempt for task ${taskId} failed:`, pollError.message);
            // Continue polling even if one attempt fails
        }
    }
    throw new Error(`Mockup task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

async function createMockupGenerationTask(payload, event) {
    console.log('[MOCKUPS] Creating mockup task with payload:', JSON.stringify(payload, null, 2));
    let taskResponse;
    try {
        // Pass payload as object, not stringified - printful-proxy will stringify it
        taskResponse = await makePrintfulApiCall('/v2/mockup-tasks', { method: 'POST', body: payload }, event);
        console.log('[MOCKUPS] Mockup task response:', JSON.stringify(taskResponse, null, 2));
    } catch (err) {
        console.error('[MOCKUPS] Error creating mockup task:', err.message);
        if (/rate limit|too many requests|429/i.test(err.message)) {
            console.warn('[MOCKUPS] Rate limit detected. Returning pending for client retry.');
            return { pending: true, rate_limited: true, retry_payload: payload };
        }
        throw err; // Re-throw other errors
    }

    // Check if response indicates an error
    if (taskResponse?.success === false) {
        const reason = taskResponse?.details?.error?.reason || '';
        const msg = (taskResponse?.error || '').toString();
        console.error('[MOCKUPS] Printful API returned error:', taskResponse.error, taskResponse.details);
        // Treat TooManyRequests as a pending state to avoid failing the flow
        if (/TooManyRequests/i.test(reason) || /rate limit/i.test(msg)) {
            const retryAfter = Number(taskResponse?.retryAfter) || null;
            console.warn('[MOCKUPS] Rate limit in response body. Returning pending for client retry.', { retryAfter });
            return { pending: true, rate_limited: true, retryAfter, retry_payload: payload };
        }
        throw new Error(`Printful API error: ${taskResponse.error || 'Unknown error'}`);
    }

    // printful-proxy wraps response as { success, data: { data: [...], extra: [] }, rateLimit }
    // So we need to access data.data[0].id
    const taskId = taskResponse?.data?.data?.[0]?.id;
    if (!taskId) {
        console.error('[MOCKUPS] No task ID in response. Response structure:', JSON.stringify(taskResponse, null, 2));
        throw new Error('No task ID returned from mockup creation');
    }

    console.log(`[MOCKUPS] Task created with ID: ${taskId}. Returning pending for client polling.`);
    // Return immediately with task ID for client polling instead of blocking for 240 seconds
    const result = { pending: true, task_id: taskId };
    console.log('[MOCKUPS] Returning result:', result);
    return result;
}

// --- Main Handler ---

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        // The orchestrator sends technique at the top level.
        const { catalog_product_id, placement_files, style_id, technique, catalog_variant_id, selling_region_name, mockup_style_ids } = body;

        if (!catalog_product_id || !Array.isArray(placement_files) || placement_files.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing catalog_product_id or placement_files.' }) };
        }

        if (!technique) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing technique.' }) };
        }

        const region = (selling_region_name || 'usa').toLowerCase();

        // Fetch a default variant ID to use for mockup generation
        const resolvedVariantId = catalog_variant_id || await getDefaultVariantId(catalog_product_id, region, event);

        const styleIdsFromPayload = Array.isArray(mockup_style_ids)
            ? mockup_style_ids.filter(id => id !== null && id !== undefined)
            : [];
        let combinedStyleIds = styleIdsFromPayload.length > 0
            ? styleIdsFromPayload
            : (style_id ? [style_id] : []);

        console.log(`[MOCKUPS] Received mockup_style_ids from request:`, mockup_style_ids);
        console.log(`[MOCKUPS] Filtered styleIdsFromPayload:`, styleIdsFromPayload);
        console.log(`[MOCKUPS] Combined style IDs to use:`, combinedStyleIds);

        // If no mockup_style_ids provided, fetch available styles
        if (combinedStyleIds.length === 0) {
            console.log(`[MOCKUPS] No mockup styles specified. Fetching available styles...`);
            try {
                const stylesResponse = await makePrintfulApiCall(
                    `/v2/catalog-products/${catalog_product_id}/mockup-styles?selling_region_name=${region}`,
                    {},
                    event
                );
                console.log(`[MOCKUPS] Raw styles response:`, JSON.stringify(stylesResponse, null, 2));

                // Response is grouped by placement/technique, extract all mockup_styles
                const placementGroups = stylesResponse?.data?.data || stylesResponse?.data || [];
                const allMockupStyles = [];

                placementGroups.forEach(group => {
                    if (Array.isArray(group?.mockup_styles)) {
                        group.mockup_styles.forEach(style => {
                            if (style?.id) {
                                allMockupStyles.push({
                                    id: style.id,
                                    category: style.category_name || style.category || '',
                                    view: style.view_name || style.view || ''
                                });
                            }
                        });
                    }
                });

                console.log(`[MOCKUPS] Found ${allMockupStyles.length} mockup styles for product ${catalog_product_id}:`, allMockupStyles);

                if (allMockupStyles.length > 0) {
                    // Select diverse styles (prefer model/lifestyle, then flat views)
                    const modelStyle = allMockupStyles.find(s =>
                        s.category.toLowerCase().includes('model') ||
                        s.category.toLowerCase().includes('lifestyle')
                    );
                    const flatFront = allMockupStyles.find(s =>
                        s.view.toLowerCase() === 'front' &&
                        s.category.toLowerCase().includes('flat')
                    );
                    const backView = allMockupStyles.find(s => s.view.toLowerCase() === 'back');

                    // Take up to 5 diverse styles
                    const selectedStyles = [
                        modelStyle,
                        flatFront,
                        backView,
                        ...allMockupStyles.filter(s =>
                            s !== modelStyle && s !== flatFront && s !== backView
                        ).slice(0, 2)
                    ].filter(Boolean);

                    combinedStyleIds = selectedStyles.map(s => s.id);
                    console.log(`[MOCKUPS] Selected ${combinedStyleIds.length} diverse mockup styles:`, selectedStyles);
                } else {
                    console.warn(`[MOCKUPS] No mockup styles found for product ${catalog_product_id}`);
                    combinedStyleIds = [];
                }
            } catch (err) {
                console.warn(`[MOCKUPS] Failed to fetch mockup styles:`, err.message);
                combinedStyleIds = [];
            }
        }
        
        console.log(`[MOCKUPS] Using mockup style IDs:`, combinedStyleIds);

        const mockupPayload = {
            format: 'png',
            products: [{
                source: 'catalog',
                catalog_product_id: Number(catalog_product_id),
                catalog_variant_ids: [resolvedVariantId],
                ...(combinedStyleIds.length ? { mockup_style_ids: combinedStyleIds } : {}),
                placements: placement_files.map(pf => {
                    // Convert from pixels to inches using DPI, since API validates in inches
                    const dpi = Math.round(Number(pf.dpi) || 300);
                    const areaWidthPx = Math.round(Number(pf.width) || 1000);
                    const areaHeightPx = Math.round(Number(pf.height) || 1000);
                    const areaWidthIn = Number((areaWidthPx / dpi).toFixed(2));
                    const areaHeightIn = Number((areaHeightPx / dpi).toFixed(2));

                    // Fill entire print area (in inches)
                    const designWidthIn = areaWidthIn;
                    const designHeightIn = areaHeightIn;
                    const leftIn = 0;
                    const topIn = 0;

                    const urlWithCb = (() => {
                        let srcUrl = pf.image_url || '';
                        try {
                            const u = new URL(srcUrl);
                            if (u.pathname && u.pathname.includes('/.netlify/functions/resize-image-public')) {
                                const inner = u.searchParams.get('url');
                                if (inner) {
                                    srcUrl = decodeURIComponent(inner);
                                    console.warn('[MOCKUPS] Stripped resize-image-public wrapper. Using original URL for Printful fetch.');
                                }
                            }
                        } catch (e) {
                            // ignore URL parse errors, fall back to original
                        }
                        const sep = srcUrl.includes('?') ? '&' : '?';
                        return `${srcUrl}${sep}cb=${Date.now()}`;
                    })();

                    console.log(`[MOCKUPS] Placement ${pf.placement}: area=${areaWidthPx}x${areaHeightPx}px @ ${dpi}dpi (~${areaWidthIn}x${areaHeightIn} in)`);
                    console.log(`[MOCKUPS] Position: auto-center (no position provided)`);

                    return {
                        placement: pf.placement,
                        technique: technique,
                        layers: [{
                            type: 'file',
                            url: urlWithCb
                        }]
                    };
                })
            }]
        };

        const result = await createMockupGenerationTask(mockupPayload, event);

        if (result && result.pending) {
            return {
                statusCode: 202, // Use 202 Accepted for pending tasks
                body: JSON.stringify({ success: true, pending: true, ...result })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, mockups: result })
        };

    } catch (error) {
        console.error('[generate-main-mockup] Unhandled Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};