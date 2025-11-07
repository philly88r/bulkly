// netlify/functions/get-printful-printfile-specs.js
// Fetches exact printfile dimensions from Printful API for a given variant/placement
// Returns: { width, height, dpi, printfile_id } for proper resizing

const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

function simpleDecrypt(encryptedBase64, key) {
  const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
  const keyLength = key.length;
  const result = [];
  for (let i = 0; i < encryptedBytes.length; i++) {
    result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
  }
  return Buffer.from(result).toString('utf8');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };
  }

  try {
    const { variant_id, placement = 'front' } = event.queryStringParameters || {};
    
    if (!variant_id) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: 'Missing required parameter: variant_id' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Unauthorized - No token' }) };
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.sub || decoded.id;
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Unauthorized - Invalid token' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printful_access_token_encrypted')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.printful_access_token_encrypted) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success: false, error: 'Printful OAuth not connected' }) };
    }

    const authToken = simpleDecrypt(user.printful_access_token_encrypted, process.env.JWT_SECRET);
    const store_id = event.queryStringParameters?.store_id;
    
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
      // Using OAuth - no store ID header needed
    };

    // Get printfile specs for this variant
    const url = `https://api.printful.com/mockup-generator/printfiles/${variant_id}`;
    console.log('[get-printful-printfile-specs] Fetching specs for variant:', variant_id);
    
    const response = await fetch(url, { headers });
    const data = await response.json();

    if (!response.ok || !data?.result) {
      console.error('[get-printful-printfile-specs] API error:', data);
      return { statusCode: response.status || 500, headers: cors, body: JSON.stringify({ success: false, error: 'Failed to fetch printfile specs', details: data }) };
    }

    // Find the printfile for the requested placement
    const { printfiles, variant_printfiles } = data.result;
    
    // Find the printfile_id for this placement
    let printfileId = null;
    const variantPrintfile = variant_printfiles.find(v => v.variant_id === parseInt(variant_id));
    
    if (variantPrintfile && variantPrintfile.placements && variantPrintfile.placements[placement]) {
      printfileId = variantPrintfile.placements[placement];
    } else {
      // Fallback to first printfile if placement not found
      printfileId = printfiles[0]?.printfile_id;
    }

    const printfile = printfiles.find(p => p.printfile_id === printfileId);
    
    if (!printfile) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ success: false, error: 'Printfile not found for placement', placement }) };
    }

    const result = {
      success: true,
      printfile: {
        width: printfile.width,
        height: printfile.height,
        dpi: printfile.dpi,
        printfile_id: printfile.printfile_id,
        placement: placement,
        variant_id: parseInt(variant_id)
      }
    };

    console.log(`[get-printful-printfile-specs] EXACT DIMENSIONS RETRIEVED: ${printfile.width}x${printfile.height} @ ${printfile.dpi} DPI for placement '${placement}' on variant ${variant_id} (printfile_id: ${printfile.printfile_id})`);
    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };

  } catch (error) {
    console.error('[get-printful-printfile-specs] Error:', error);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: 'Internal server error', details: error.message }) };
  }
};
