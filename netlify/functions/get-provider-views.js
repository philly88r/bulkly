// netlify/functions/get-provider-views.js
// Fetches blueprint views, placeholders, and variants for mockup generation

exports.handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: cors, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
    }

    try {
        const { blueprint_id, provider_id, fallbackIf404 } = JSON.parse(event.body || '{}');
        const authToken = event.headers.authorization?.replace('Bearer ', '');

        if (!authToken) {
            return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'No authorization token' }) };
        }

        if (!blueprint_id || !provider_id) {
            return { statusCode: 400, headers: cors, body: JSON.stringify({ 
                success: false, 
                error: 'Missing required fields: blueprint_id, provider_id' 
            }) };
        }

        console.log(`Fetching provider views for blueprint ${blueprint_id}, provider ${provider_id}`);

        // Helper to fetch provider details with views and placeholders
        const fetchProviderViews = async (bpId, ppId) => {
            return fetch(`https://api.printify.com/v1/catalog/blueprints/${bpId}/print_providers/${ppId}.json`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                }
            });
        };

        let response = await fetchProviderViews(blueprint_id, provider_id);

        // If 404 and fallback enabled, try the first provider from blueprint list
        if (response.status === 404 && fallbackIf404) {
            console.warn(`Provider ${provider_id} not found for blueprint ${blueprint_id}. Falling back to first available provider.`);
            const bpResp = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprint_id}.json`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                }
            });
            if (bpResp.ok) {
                const bp = await bpResp.json();
                const firstProviderId = bp?.print_providers?.[0]?.id;
                if (firstProviderId) {
                    response = await fetchProviderViews(blueprint_id, firstProviderId);
                    if (response.ok) {
                        const data = await response.json();
                        return {
                            statusCode: 200,
                            headers: cors,
                            body: JSON.stringify({
                                success: true,
                                views: data.views || [],
                                placeholders: data.placeholders || [],
                                variants: data.variants || [],
                                blueprint_id: data.id,
                                provider_id: data.print_provider_id,
                                provider_used: firstProviderId,
                                note: 'Requested provider not found; fell back to first available provider for this blueprint.'
                            })
                        };
                    }
                }
            }
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Upstream error ${response.status}: ${text}`);
        }

        const data = await response.json();
        
        // Extract relevant data for mockup generation
        const result = {
            success: true,
            views: data.views || [],
            placeholders: data.placeholders || [],
            variants: data.variants || [],
            blueprint_id: data.id,
            provider_id: data.print_provider_id,
            provider_used: data.print_provider_id
        };

        console.log(`Found ${result.views.length} views, ${result.placeholders.length} placeholders, ${result.variants.length} variants`);

        return {
            statusCode: 200,
            headers: cors,
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Get provider views error:', error);
        return {
            statusCode: 500,
            headers: cors,
            body: JSON.stringify({
                success: false,
                error: error.message || 'Failed to fetch provider views'
            })
        };
    }
};
