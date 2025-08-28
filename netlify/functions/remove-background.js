// netlify/functions/remove-background.js
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/**
 * Removes background from an image using BRIA RMBG 2.0 model
 * @param {string} imageUrl - URL of the image to process
 * @param {string} apiKey - FAL API key
 * @returns {Promise<Object>} - Processed image data
 */
async function removeBackground(imageUrl, apiKey) {
    console.log('Starting background removal for image:', imageUrl.substring(0, 100) + '...');
    
    try {
        const response = await fetch('https://fal.run/fal-ai/bria/background/remove', {
            method: 'POST',
            headers: {
                'Authorization': `Key ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                image_url: imageUrl,
                sync_mode: true,
            }),
        });

        const responseText = await response.text();
        console.log('BRIA API response status:', response.status);
        console.log('BRIA API response headers:', JSON.stringify([...response.headers.entries()]));
        console.log('BRIA API response body:', responseText);

        if (!response.ok) {
            throw new Error(`BRIA API error (${response.status}): ${responseText}`);
        }

        let result;
        try {
            result = responseText ? JSON.parse(responseText) : {};
        } catch (parseError) {
            console.error('Failed to parse BRIA API response:', parseError);
            throw new Error('Invalid JSON response from BRIA API');
        }
        
        if (!result.image || !result.image.url) {
            console.error('Invalid BRIA API response format:', JSON.stringify(result, null, 2));
            throw new Error('Invalid response format from BRIA API - no image URL returned');
        }

        console.log('Background removal successful, result:', {
            url: result.image.url,
            width: result.image.width,
            height: result.image.height
        });
        return result.image;
    } catch (error) {
        console.error('Error in removeBackground:', error);
        throw error; // Re-throw to be handled by the caller
    }
}

exports.handler = async (event, context) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
            },
            body: '',
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { imageUrl, designId, imageId } = JSON.parse(event.body);
        const actualDesignId = designId || imageId;

        if (!imageUrl) {
            throw new Error('No image URL provided');
        }

        console.log('Processing background removal for design:', actualDesignId);

        const FAL_KEY = process.env.FAL_KEY;
        if (!FAL_KEY) {
            throw new Error('FAL_KEY environment variable not set');
        }

        // Process the image with BRIA RMBG 2.0
        const result = await removeBackground(imageUrl, FAL_KEY);

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST',
            },
            body: JSON.stringify({
                success: true,
                data: {
                    image_url: result.url,
                    width: result.width,
                    height: result.height,
                    file_name: result.file_name || 'background_removed.png',
                    file_size: result.file_size
                },
                message: 'Background removal completed successfully',
                model: 'bria-rmbg-2.0'
            })
        };

    } catch (error) {
        console.error('Background removal error:', error);
        return {
            statusCode: error.statusCode || 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST',
            },
            body: JSON.stringify({
                success: false,
                error: error.message,
                code: error.code || 'BACKGROUND_REMOVAL_ERROR'
            })
        };
    }
};