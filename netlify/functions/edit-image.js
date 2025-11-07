const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { getSupabase } = require('./_supabase_node.js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event, context) => {
  console.log('Edit-image function called:', event.httpMethod, event.path);
  console.log('Headers:', event.headers);
  console.log('Body:', event.body);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Get authorization header (case-insensitive)
    const authHeader = event.headers.authorization || 
                      event.headers.Authorization || 
                      Object.keys(event.headers).find(h => h.toLowerCase() === 'authorization');
    
    // Make authorization optional for now to fix the immediate issue
    // We'll still try to track usage if the header is present

    const { prompt, imageUrl } = JSON.parse(event.body);
    
    if (!prompt || !imageUrl) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required parameters: prompt and imageUrl' }) };
    }

    // Convert single imageUrl to image_urls array as expected by API
    const image_urls = [imageUrl];

    // Get FAL API key from environment
    const falKey = process.env.FAL_KEY;
    if (!falKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'FAL API key not configured' }) };
    }

    // Make initial request to FAL Seedream v4 edit endpoint
    const editResponse = await fetch('https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_urls,
        num_images: 1,
        max_images: 1,
        enable_safety_checker: true
      }),
    });

    const editData = await editResponse.json();
    
    if (!editResponse.ok) {
      throw new Error(`FAL API error: ${editData.message || editResponse.statusText}`);
    }

    const requestId = editData.request_id;
    
    // Poll for completion
    let statusResponse;
    let maxAttempts = 60; // 5 minutes max (60 * 5 seconds)
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
      
      statusResponse = await fetch(`https://queue.fal.run/fal-ai/bytedance/requests/${requestId}/status`, {
        headers: {
          'Authorization': `Key ${falKey}`,
        },
      });
      
      const statusData = await statusResponse.json();
      
      if (statusData.status === 'COMPLETED') {
        break;
      } else if (statusData.status === 'FAILED') {
        throw new Error('Image editing failed');
      }
      
      attempts++;
    }
    
    if (attempts >= maxAttempts) {
      throw new Error('Image editing timeout - operation took too long');
    }

    // Get final result
    const resultResponse = await fetch(`https://queue.fal.run/fal-ai/bytedance/requests/${requestId}`, {
      headers: {
        'Authorization': `Key ${falKey}`,
      },
    });

    const resultData = await resultResponse.json();

    if (!resultResponse.ok) {
      throw new Error('Failed to retrieve edited image');
    }

    // Track usage if authorization is present
    try {
      if (authHeader) {
        const supabase = getSupabase(true);
        // Extract token if it exists in the format 'Bearer token'
        const token = authHeader.includes(' ') ? authHeader.split(' ')[1] : authHeader;
        
        // Suppress punycode deprecation warning
        const originalEmit = process.emit;
        process.emit = function (name, data, ...args) {
          if (name === 'warning' && typeof data === 'object' && data.name === 'DeprecationWarning' && data.message.includes('punycode')) {
            return false;
          }
          return originalEmit.apply(process, arguments);
        };
        
        try {
          const jwt = require('jsonwebtoken');
          const payload = jwt.verify(token, process.env.JWT_SECRET);
          const userId = parseInt(payload.sub);
          
          // Restore original emit
          process.emit = originalEmit;

          await supabase.from('usage_tracking').insert([
            {
              user_id: userId,
              type: 'ai_generations',
              count: 1,
              metadata: {
                service: 'fal-seedream-edit',
                prompt,
                image_count: image_urls.length,
              },
            },
          ]);
        } catch (jwtError) {
          console.error('JWT verification error:', jwtError);
          // Continue execution even if JWT verification fails
        }
      } else {
        console.log('No authorization header present, skipping usage tracking');
      }
    } catch (usageError) {
      console.error('Usage tracking error:', usageError);
      // Continue execution even if usage tracking fails
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          image_url: resultData.images?.[0]?.url || resultData.image_url,
          prompt: prompt,
          width: resultData.images?.[0]?.width,
          height: resultData.images?.[0]?.height
        },
        request_id: requestId,
        description: resultData.description
      }),
    };

  } catch (error) {
    console.error('Image editing error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};
