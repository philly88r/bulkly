// netlify/functions/create-product.js
// Creates a Printify product with uploaded designs and proper variant pricing

// Use CommonJS require for compatibility
const fetch = require('node-fetch');

// Export the handler function
exports.handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: cors, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
    }

    try {
        console.log('Request received to create-product.js');
        const { shopId, product, providerId, printAreas, selectedImages, content, placementOverrides, markup } = JSON.parse(event.body);
        
        // Extract JWT token for user authentication
        let authToken = null;
        
        if (event.headers.authorization) {
            authToken = event.headers.authorization.replace(/^Bearer\s+/i, '');
        } else if (event.headers.Authorization) {
            authToken = event.headers.Authorization.replace(/^Bearer\s+/i, '');
        }
        
        // Also check if token was passed in the request body
        if (!authToken && event.body) {
            try {
                const bodyData = JSON.parse(event.body);
                if (bodyData.token || bodyData.authToken || bodyData.apiToken) {
                    authToken = bodyData.token || bodyData.authToken || bodyData.apiToken;
                }
            } catch (e) {
                // Ignore parsing errors
            }
        }

        console.log('Request parameters:', { 
            shopId, 
            productId: product?.id,
            productTitle: product?.title,
            blueprint_id: product?.blueprint_id,
            providerId,
            printAreasCount: printAreas?.length,
            selectedImagesKeys: Object.keys(selectedImages || {}),
            authTokenPresent: !!authToken,
            placementOverridesKeys: Object.keys(placementOverrides || {})
        });

        if (!authToken) {
            return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Unauthorized - No valid authentication token provided' }) };
        }

        if (!shopId || !product || !providerId || !printAreas || !selectedImages) {
            return { statusCode: 400, headers: cors, body: JSON.stringify({ 
                success: false, 
                error: 'Missing required fields: shopId, product, providerId, printAreas, selectedImages' 
            }) };
        }

        console.log(`Creating product: ${product.title} (ID: ${product.id}, Blueprint: ${product.blueprint_id}, Provider: ${providerId})`);

        // Use the same robust API key retrieval and decryption as printify-proxy.js
        const jwt = require('jsonwebtoken');
        const { createClient } = require('@supabase/supabase-js');

        function simpleDecrypt(encryptedBase64, key) {
            const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
            const keyLength = key.length;
            const result = [];
            for (let i = 0; i < encryptedBytes.length; i++) {
                result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
            }
            return Buffer.from(result).toString('utf8');
        }

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
        const userId = decoded.sub || decoded.id;

        const { data: user, error: userError } = await supabase
            .from('users')
            .select('printify_api_key_encrypted')
            .eq('id', userId)
            .single();

        if (userError || !user || !user.printify_api_key_encrypted) {
            console.error('Error fetching user API key:', userError);
            return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Printify API key not found for user.' }) };
        }

        const printifyApiToken = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
        if (!printifyApiToken) {
            return {
                statusCode: 401,
                headers: cors,
                body: JSON.stringify({
                    success: false,
                    error: 'No Printify API key found. Please set your API key in settings.'
                })
            };
        }
        
        console.log(`Using user's Printify API key: Present (length: ${printifyApiToken.length})`);

        // Step 1: Get variants for the specific blueprint and print provider
        console.log(`Fetching variants for blueprint ${product.blueprint_id} and provider ${providerId}`);
        
        const variantsUrl = `https://api.printify.com/v1/catalog/blueprints/${product.blueprint_id}/print_providers/${providerId}/variants.json`;
        
        const variantsResponse = await fetch(variantsUrl, {
            headers: {
                'Authorization': `Bearer ${printifyApiToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`Variants API response status: ${variantsResponse.status}`);
        
        if (!variantsResponse.ok) {
            const errorText = await variantsResponse.text();
            console.error(`Variants API error: ${variantsResponse.status} - ${errorText}`);
            return { 
                statusCode: variantsResponse.status, 
                headers: cors, 
                body: JSON.stringify({ 
                    success: false, 
                    error: `Failed to fetch variants: ${variantsResponse.status} - ${errorText}` 
                }) 
            };
        }

        const variantsData = await variantsResponse.json();
        
        // Handle the correct Printify API response structure
        let variants = [];
        if (variantsData.variants && Array.isArray(variantsData.variants)) {
            variants = variantsData.variants;
        } else if (Array.isArray(variantsData)) {
            variants = variantsData;
        } else {
            console.error('Unexpected variants response structure:', variantsData);
            return { 
                statusCode: 500, 
                headers: cors, 
                body: JSON.stringify({ 
                    success: false, 
                    error: 'Unexpected variants response structure' 
                }) 
            };
        }
        
        // Filter variants to only include those that are in stock
        const inStockVariants = variants.filter(variant => {
            return variant.is_available !== false && variant.is_in_stock !== false;
        });
        
        console.log(`Filtered ${variants.length} variants down to ${inStockVariants.length} in-stock variants`);
        
        // Limit to maximum 100 variants to avoid Printify's limit
        const MAX_VARIANTS = 100;
        if (inStockVariants.length > MAX_VARIANTS) {
            console.log(`Limiting variants from ${inStockVariants.length} to ${MAX_VARIANTS} to avoid Printify's limit`);
            variants = inStockVariants.slice(0, MAX_VARIANTS);
        } else {
            variants = inStockVariants;
        }
        
        if (variants.length === 0) {
            return { 
                statusCode: 400, 
                headers: cors, 
                body: JSON.stringify({ 
                    success: false, 
                    error: `No variants available for blueprint ${product.blueprint_id} with provider ${providerId}` 
                }) 
            };
        }
        
        console.log(`Found ${variants.length} variants`);

        // The `selectedImages` object is now expected to contain pre-uploaded image IDs.
        // The keys are size strings (e.g., '1200x1200') and values are the Printify image IDs.
        const uploadedImages = selectedImages;
        console.log('Using pre-uploaded image IDs:', uploadedImages);

        if (!uploadedImages || Object.keys(uploadedImages).length === 0) {
            throw new Error('No pre-uploaded images were provided.');
        }

        // Helper to clamp values safely
        const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

        // Step 3: Build print areas with uploaded images
        const printAreasPayload = [];
        
        // Group print areas by position and find matching images
        const areasByPosition = {};
        printAreas.forEach(area => {
            if (!areasByPosition[area.position]) {
                areasByPosition[area.position] = [];
            }
            areasByPosition[area.position].push(area);
        });

        // Create print area entries for each position
        Object.entries(areasByPosition).forEach(([position, areas]) => {
            const area = areas[0];
            const sizeKey = `${area.width}x${area.height}`;
            const fileId = uploadedImages[sizeKey];

            if (fileId) {
                // Apply placement overrides if provided
                const o = (placementOverrides && placementOverrides[sizeKey]) || {};
                const x = clamp(Number.isFinite(o.x) ? o.x : 0.5, 0, 1);
                const y = clamp(Number.isFinite(o.y) ? o.y : 0.5, 0, 1);
                const scale = clamp(Number.isFinite(o.scale) ? o.scale : 1.0, 0.1, 5.0);
                let angle = Number.isFinite(o.angle) ? o.angle : 0;
                // Normalize angle to [-180, 180]
                angle = ((angle + 180) % 360 + 360) % 360 - 180;

                printAreasPayload.push({
                    variant_ids: variants.map(v => v.id),
                    placeholders: [{
                        position: position,
                        images: [{
                            id: fileId,
                            x: x,      // normalized center [0..1]
                            y: y,      // normalized center [0..1]
                            scale: scale,   // relative scale
                            angle: angle    // rotation in degrees
                        }]
                    }]
                });
                console.log(`Added print area for position ${position} with image ${fileId} and placement {x:${x}, y:${y}, scale:${scale}, angle:${angle}}`);
            }
        });

        if (printAreasPayload.length === 0) {
            throw new Error('No valid print areas could be created');
        }

        // Step 3.5: Fetch AI content from database if not provided
        let aiContent = content;
        if (!aiContent || !aiContent.title || !aiContent.description || !aiContent.tags || !aiContent.key_features || !aiContent.materials) {
            console.log('AI content missing or incomplete, fetching from database...');
            try {
                const supabaseUrl = process.env.SUPABASE_URL || 'https://opimwwjihemymwtdwdir.supabase.co';
                const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waW13d2ppaGVteW13dGR3ZGlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjQ2MDI3NDcsImV4cCI6MjA0MDE3ODc0N30.VUgpgJJaVQIqU7zWUOhHQJmkdJBhXqJkKGBGLJBhXqI';
                
                const contentResponse = await fetch(`${supabaseUrl}/rest/v1/ai_generated_content?product_id=eq.${encodeURIComponent(product.id)}&select=*`, {
                    headers: {
                        'Authorization': `Bearer ${supabaseKey}`,
                        'apikey': supabaseKey,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (contentResponse.ok) {
                    const contentData = await contentResponse.json();
                    if (contentData && contentData.length > 0) {
                        const dbContent = contentData[0];
                        aiContent = {
                            title: dbContent.title,
                            description: dbContent.description,
                            tags: dbContent.tags || [],
                            key_features: dbContent.key_features || [],
                            materials: dbContent.materials || []
                        };
                        console.log('Successfully fetched AI content from database');
                    } else {
                        console.warn('No AI content found in database for product:', product.id);
                    }
                } else {
                    console.warn('Failed to fetch AI content from database, using fallbacks');
                }
            } catch (error) {
                console.warn('Error fetching AI content:', error.message);
            }
        }

        // Step 4: Build product payload
        // Determine variant pricing using provider costs when available and requested markup
        const appliedMarkup = Number.isFinite(markup) ? Number(markup) : 40; // percentage
        const computePriceCents = (variant) => {
            try {
                const base = Number(variant.cost);
                if (Number.isFinite(base) && base > 0) {
                    // Variant cost is returned in cents
                    const price = Math.round(base * (1 + (appliedMarkup / 100)));
                    return Math.max(price, base + 1); // ensure >= cost + 1 cent
                }
            } catch(e) {}
            // Fallback to $20 if cost missing
            return 2000;
        };
        // Sanitize and clamp title to a conservative limit (Printify enforces a shorter max; use 75 chars)
        const MAX_TITLE = 75;
        const safeTitle = (t)=>{
            try {
                let s = String(t||'').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ''); // strip emoji/symbols
                s = s.replace(/\s+/g,' ').trim();
                if (s.length > MAX_TITLE) s = s.slice(0, MAX_TITLE).replace(/[\s\-_,.]+$/,'').trim();
                return s || 'Untitled Product';
            } catch(_) { return 'Untitled Product'; }
        };

        const productPayload = {
            title: safeTitle(aiContent?.title || product.title),
            description: aiContent?.description || product.description,
            tags: aiContent?.tags || [],
            // Include key_features if available - use snake_case here as per API specs
            key_features: aiContent?.key_features || [],
            // Include materials alongside tags (array of strings)
            materials: aiContent?.materials || [],
            blueprint_id: parseInt(product.blueprint_id),
            print_provider_id: parseInt(providerId),
            variants: variants.map(variant => ({
                id: variant.id,
                price: computePriceCents(variant),
                is_enabled: true,
                is_default: false
            })),
            print_areas: printAreasPayload,
            // Add sales channel properties with correct flat structure
            sales_channel_properties: {
                free_shipping: false
            }
        };

        // Set the first variant as default
        if (productPayload.variants.length > 0) {
            productPayload.variants[0].is_default = true;
        }

        console.log(`Creating product with ${productPayload.variants.length} variants at $20 each`);
        
        // Log detailed product payload information
        console.log('Product payload details:');
        console.log('- Title:', productPayload.title);
        console.log('- Description:', productPayload.description?.substring(0, 50) + '...');
        console.log('- Tags:', JSON.stringify(productPayload.tags));
        console.log('- Key Features:', JSON.stringify(productPayload.key_features));
        console.log('- Materials:', JSON.stringify(productPayload.materials));
        console.log('- Print Areas:', productPayload.print_areas.length);
        console.log('- Sales Channel Properties:', JSON.stringify(productPayload.sales_channel_properties));

        // Step 5: Create the product
        const createResponse = await fetch(`https://api.printify.com/v1/shops/${shopId}/products.json`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${printifyApiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(productPayload)
        });

        if (!createResponse.ok) {
            const errorText = await createResponse.text();
            console.error('Product creation failed:', errorText);
            return {
                statusCode: createResponse.status,
                headers: cors,
                body: JSON.stringify({
                    success: false,
                    error: `Product creation failed: ${createResponse.status}`,
                    details: errorText
                })
            };
        }

        const createdProduct = await createResponse.json();
        console.log(`Successfully created product: ${createdProduct.title} (ID: ${createdProduct.id})`);

        return {
            statusCode: 200,
            headers: cors,
            body: JSON.stringify({
                success: true,
                product: createdProduct
            })
        };

    } catch (error) {
        console.error('Create product error:', error);
        return {
            statusCode: 500,
            headers: cors,
            body: JSON.stringify({
                success: false,
                error: error.message || 'Failed to create product'
            })
        };
    }
};