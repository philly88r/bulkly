// netlify/functions/check-shop-connection.js
// A diagnostic tool to check the connection status of a specific Printify shop.

const fetch = require('node-fetch');

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
        console.log('Request received to check-shop-connection.js');
        const { shopId } = JSON.parse(event.body);

        if (!shopId) {
            return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Missing required field: shopId' }) };
        }

        let authToken = event.headers.authorization?.replace(/^Bearer\s+/i, '');

        if (!authToken) {
            return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Unauthorized - No auth token' }) };
        }

        console.log(`Fetching API key for shop: ${shopId}`);
        const apiKeyResponse = await fetch(`${event.rawUrl.split('/.netlify')[0]}/.netlify/functions/get-api-key`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        if (!apiKeyResponse.ok) {
            const errorText = await apiKeyResponse.text();
            console.error('Failed to get user API key:', errorText);
            return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Failed to get Printify API key.' }) };
        }

        const { apiKey: printifyApiToken } = await apiKeyResponse.json();
        if (!printifyApiToken) {
            return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'No Printify API key found.' }) };
        }

        console.log(`Checking connection for shop ${shopId}...`);
        const shopInfoResponse = await fetch(`https://api.printify.com/v1/shops/${shopId}.json`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${printifyApiToken}`,
                'Content-Type': 'application/json'
            }
        });

        const responseBody = await shopInfoResponse.text();

        if (!shopInfoResponse.ok) {
            console.error(`Failed to get shop info: ${shopInfoResponse.status}`, responseBody);
            return {
                statusCode: shopInfoResponse.status,
                headers: cors,
                body: JSON.stringify({
                    success: false,
                    error: `Shop info request failed with status ${shopInfoResponse.status}`,
                    details: responseBody
                })
            };
        }

        const shopInfo = JSON.parse(responseBody);
        console.log('Successfully fetched shop info:', shopInfo);

        return {
            statusCode: 200,
            headers: cors,
            body: JSON.stringify({
                success: true,
                shopInfo: shopInfo
            })
        };

    } catch (error) {
        console.error('Check shop connection error:', error);
        return {
            statusCode: 500,
            headers: cors,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};
