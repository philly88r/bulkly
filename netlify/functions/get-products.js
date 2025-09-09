const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Simple decryption function for API keys
function simpleDecrypt(encryptedBase64, key) {
    const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
    const keyLength = key.length;
    const result = [];
    for (let i = 0; i < encryptedBytes.length; i++) {
        result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
    }
    return Buffer.from(result).toString('utf8');
}

exports.handler = async (event, context) => {
    console.log('get-products function called');
    
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Content-Type': 'application/json'
    };
    
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        // Extract JWT token for user authentication
        let authToken = null;
        
        if (event.headers.authorization) {
            authToken = event.headers.authorization.replace(/^Bearer\s+/i, '');
        } else if (event.headers.Authorization) {
            authToken = event.headers.Authorization.replace(/^Bearer\s+/i, '');
        }
        
        console.log('Auth token exists:', !!authToken);
        
        if (!authToken) {
            return { 
                statusCode: 401, 
                headers, 
                body: JSON.stringify({ 
                    error: 'Unauthorized - No valid authentication token provided' 
                }) 
            };
        }

        // Initialize Supabase client
        const supabase = createClient(
            process.env.SUPABASE_URL, 
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
        
        // Verify JWT token
        let userId;
        try {
            const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
            userId = decoded.sub || decoded.id;
            console.log('User authenticated:', userId);
        } catch (jwtError) {
            console.error('JWT verification failed:', jwtError);
            return { 
                statusCode: 401, 
                headers, 
                body: JSON.stringify({ 
                    error: 'Unauthorized - Invalid token' 
                }) 
            };
        }
        
        // Get user's Printify API key
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('printify_api_key_encrypted')
            .eq('id', userId)
            .single();

        if (userError || !user || !user.printify_api_key_encrypted) {
            console.error('Error fetching user API key:', userError);
            return { 
                statusCode: 401, 
                headers, 
                body: JSON.stringify({ 
                    error: 'Printify API key not found for user.' 
                }) 
            };
        }

        const printifyApiToken = simpleDecrypt(
            user.printify_api_key_encrypted, 
            process.env.JWT_SECRET
        );
        
        if (!printifyApiToken) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({
                    error: 'No Printify API key found. Please set your API key in settings.'
                })
            };
        }
        
        console.log(`Using user's Printify API key: Present (length: ${printifyApiToken.length})`);

        // Step 1: Get user's shops
        console.log('Fetching user shops from Printify');
        const shopsResponse = await fetch('https://api.printify.com/v1/shops.json', {
            headers: {
                'Authorization': `Bearer ${printifyApiToken}`
            }
        });

        if (!shopsResponse.ok) {
            const errorText = await shopsResponse.text();
            console.error(`Shops API error: ${shopsResponse.status} - ${errorText}`);
            return { 
                statusCode: shopsResponse.status, 
                headers, 
                body: JSON.stringify({ 
                    error: `Failed to fetch shops: ${errorText}` 
                }) 
            };
        }

        const shops = await shopsResponse.json();
        console.log(`Found ${shops.length} shops`);

        if (!shops || shops.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    products: [],
                    total: 0
                })
            };
        }

        // Step 2: Get products from all shops
        const allProducts = [];
        let totalProducts = 0;

        for (const shop of shops) {
            console.log(`Fetching products for shop ${shop.id} (${shop.title})`);
            
            // Get first page of products
            const productsResponse = await fetch(
                `https://api.printify.com/v1/shops/${shop.id}/products.json`, 
                {
                    headers: {
                        'Authorization': `Bearer ${printifyApiToken}`
                    }
                }
            );

            if (!productsResponse.ok) {
                console.error(`Products API error for shop ${shop.id}: ${productsResponse.status}`);
                continue; // Skip this shop if there's an error
            }

            const productsData = await productsResponse.json();
            
            // Handle different API response formats
            let products = [];
            let total = 0;
            
            if (productsData.data && Array.isArray(productsData.data)) {
                // Paginated response format
                products = productsData.data;
                total = productsData.total || products.length;
            } else if (Array.isArray(productsData)) {
                // Direct array response format
                products = productsData;
                total = products.length;
            } else {
                console.error('Unexpected products response structure:', productsData);
                continue;
            }
            
            console.log(`Found ${products.length} products in shop ${shop.id}`);
            
            // Process products
            products.forEach(product => {
                // Add shop_id to each product for reference
                product.shop_id = shop.id;
                
                // Ensure images have proper structure
                if (!product.images) product.images = [];
                
                // Ensure variants have proper structure
                if (!product.variants) product.variants = [];
                
                // Extract product type/category from title or description if not present
                if (!product.type && product.title) {
                    const titleParts = product.title.split(' ');
                    if (titleParts.length > 1) {
                        product.type = titleParts[0];
                    }
                }
                
                // Add to collection
                allProducts.push(product);
            });
            
            totalProducts += total;
        }

        console.log(`Total products found across all shops: ${allProducts.length}`);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                products: allProducts,
                total: totalProducts
            })
        };
    } catch (error) {
        console.error('Error fetching products:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
                error: 'Failed to fetch products', 
                details: error.message 
            })
        };
    }
};
