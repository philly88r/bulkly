// netlify/functions/print-area-sizes.js

const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Printify API configuration
const PRINTIFY_API_BASE = 'https://api.printify.com/v1';

// Helper function for XOR decryption (matches update-api-key.js encryption)
function simpleDecrypt(encryptedBase64, key) {
  try {
    const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
    const keyLength = key.length;
    const result = [];
    
    for (let i = 0; i < encryptedBytes.length; i++) {
      const byte = encryptedBytes[i];
      const keyCharCode = key.charCodeAt(i % keyLength);
      result.push(byte ^ keyCharCode);
    }
    
    return Buffer.from(result).toString('utf8');
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}

exports.handler = async (event, context) => {
  console.log('[print-area-sizes] Function invoked');
  console.log('[print-area-sizes] HTTP Method:', event.httpMethod);
  
  // Log headers in a more readable format
  const headersObj = {};
  for (const key in event.headers) {
    headersObj[key.toLowerCase()] = event.headers[key];
  }
  console.log('[print-area-sizes] Headers (normalized):', JSON.stringify(headersObj));
  console.log('[print-area-sizes] Body:', event.body);
  
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Method not allowed. Use POST.'
      })
    };
  }

  try {
    // Parse request body
    const { blueprintId, providerId } = JSON.parse(event.body);

    // Validate required parameters
    if (!blueprintId || !providerId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Missing required parameters: blueprintId and providerId are required'
        })
      };
    }
    
    // Get the user's API key from the database using the JWT token
    const authHeader = headersObj.authorization || headersObj.Authorization;
                      
    console.log('[print-area-sizes] Auth header present:', !!authHeader);
    if (authHeader) {
      console.log('[print-area-sizes] Auth header starts with Bearer:', authHeader.startsWith('Bearer '));
      console.log('[print-area-sizes] Auth header value:', authHeader);
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[print-area-sizes] Authentication missing or invalid');
      return { 
        statusCode: 401, 
        headers, 
        body: JSON.stringify({ 
          success: false, 
          error: 'Authentication required' 
        }) 
      };
    }
    
    const token = authHeader.split(' ')[1];
    
    // Create Supabase client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    // Declare apiKey variable in the outer scope so it's accessible later
    let apiKey;
    
    try {
      // Verify the JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.sub || decoded.id;
      
      // Fetch the user's encrypted API key
      const { data: user, error } = await supabase
        .from('users')
        .select('printify_api_key_encrypted')
        .eq('id', userId)
        .single();
      
      if (error || !user || !user.printify_api_key_encrypted) {
        console.error('Error fetching user API key:', error);
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ 
            success: false, 
            error: 'Printify API key not found' 
          })
        };
      }
      
      // Decrypt the API key
      apiKey = simpleDecrypt(user.printify_api_key_encrypted, process.env.JWT_SECRET);
      
      // Validate the decrypted API key
      if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
        console.error('Invalid decrypted API key:', { length: apiKey?.length });
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ 
            success: false, 
            error: 'Invalid API key format. Please re-enter your API key in dashboard settings.' 
          })
        };
      }
      
      console.log('[print-area-sizes] Successfully retrieved API key');
      
    } catch (authError) {
      console.error('Authentication error:', authError);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'Authentication error: ' + authError.message 
        })
      };
    }

    // Use the variants endpoint to get actual print area dimensions
    const printifyUrl = `${PRINTIFY_API_BASE}/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`;
    console.log(`[print-area-sizes] API key format valid: ${!!apiKey && apiKey.length > 10}`);
    console.log(`[print-area-sizes] Request parameters: blueprintId=${blueprintId} (type: ${typeof blueprintId}), providerId=${providerId} (type: ${typeof providerId})`);
    
    // Log the actual URL being constructed
    console.log(`[print-area-sizes] Full URL: ${printifyUrl}`);
    
    // Make the API call directly - validation is handled by frontend filtering
    const url = `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`;
    console.log(`[print-area-sizes] Making request to: ${url}`);
    
    const printifyResponse = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Netlify-Function/1.0'
      }
    });

    if (!printifyResponse.ok) {
      const errorText = await printifyResponse.text();
      console.error(`Printify API error: ${printifyResponse.status} ${errorText}`);
      
      if (printifyResponse.status === 404) {
        console.log(`[print-area-sizes] Blueprint ID ${blueprintId} with provider ID ${providerId} combination not found. Using default print areas.`);
        
        // Return default print areas in pixels (no inch conversion)
        const defaultPrintAreas = [
          {
            position: 'front',
            title: 'Front',
            dimensions: {
              width: 864,  // pixels
              height: 1152, // pixels
              unit: 'px'
            },
            width: 864,
            height: 1152,
            unit: 'px'
          },
          {
            position: 'back',
            title: 'Back',
            dimensions: {
              width: 864,  // pixels
              height: 1152, // pixels
              unit: 'px'
            },
            width: 864,
            height: 1152,
            unit: 'px'
          },
          {
            position: 'left_chest',
            title: 'Left Chest',
            dimensions: {
              width: 288,  // pixels
              height: 288, // pixels
              unit: 'px'
            },
            width: 288,
            height: 288,
            unit: 'px'
          },
          {
            position: 'right_chest',
            title: 'Right Chest',
            dimensions: {
              width: 288,  // pixels
              height: 288, // pixels
              unit: 'px'
            },
            width: 288,
            height: 288,
            unit: 'px'
          }
        ];

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            data: {
              printAreas: defaultPrintAreas
            }
          })
        };
      }
      
      return {
        statusCode: printifyResponse.status,
        headers,
        body: JSON.stringify({
          success: false,
          error: `Printify API error: ${printifyResponse.status}`,
          details: errorText
        })
      };
    }

    // Parse the successful response
    const printifyData = await printifyResponse.json();
    console.log(`[print-area-sizes] Printify response:`, JSON.stringify(printifyData, null, 2));

    // Extract print areas from variants - use first available variant
    let placeholders = [];
    if (printifyData.variants && printifyData.variants.length > 0) {
      console.log(`[print-area-sizes] Found ${printifyData.variants.length} variants`);
      
      // Use the first variant (there's typically only one)
      const targetVariant = printifyData.variants[0];
      
      placeholders = targetVariant.placeholders || [];
      console.log(`[print-area-sizes] Using variant: ${targetVariant.title} with ${placeholders.length} placeholders`);
      
      // Log all placeholder details
      placeholders.forEach((placeholder, index) => {
        console.log(`[print-area-sizes] Placeholder ${index + 1}: ${placeholder.position} - ${placeholder.width}px × ${placeholder.height}px`);
      });
    }

    // Process print areas - keep all dimensions in pixels (no conversion)
    console.log(`[print-area-sizes] Processing ${placeholders.length} placeholders to print areas`);
    
    const printAreas = placeholders.map((placeholder, index) => {
      let width = parseFloat(placeholder.width);
      let height = parseFloat(placeholder.height);
      
      // Keep dimensions in pixels - no conversion needed
      console.log(`[print-area-sizes] Processing ${placeholder.position}: ${width}px × ${height}px`);
      
      return {
        position: placeholder.position,
        title: placeholder.position ? 
          placeholder.position.charAt(0).toUpperCase() + 
          placeholder.position.slice(1).replace('_', ' ') : 
          'Unknown Position',
        dimensions: {
          width: width,
          height: height,
          unit: 'px'
        },
        width: width,
        height: height,
        unit: 'px',
        // Include raw placeholder data for debugging
        raw_placeholder: placeholder
      };
    });
    
    console.log(`[print-area-sizes] Final print areas:`, printAreas.map(area => `${area.position}: ${area.width}x${area.height}px`));

    // Create size groups for the response
    const sizeGroups = {};
    printAreas.forEach(area => {
      const sizeKey = `${area.width}x${area.height}`;
      if (!sizeGroups[sizeKey]) {
        sizeGroups[sizeKey] = [];
      }
      sizeGroups[sizeKey].push(area);
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          blueprintId: blueprintId,
          providerId: providerId,
          printAreas: printAreas,
          sizeGroups: sizeGroups,
          totalAreas: printAreas.length,
          uniqueSizes: Object.keys(sizeGroups).length
        }
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    
    // Handle JSON parsing errors specifically
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Invalid JSON in request body'
        })
      };
    }

    // Handle fetch errors (network issues)
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Failed to connect to Printify API',
          details: 'Network error or API endpoint unreachable'
        })
      };
    }

    // Generic error response
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred'
      })
    };
  }
};