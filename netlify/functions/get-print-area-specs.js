const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Token crypto helpers (match printful-proxy simple XOR+base64 scheme)
function simpleDecrypt(encryptedBase64, key) {
  try {
    if (!encryptedBase64 || typeof encryptedBase64 !== 'string') return '';
    const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
    const keyLength = key.length;
    const result = [];
    for (let i = 0; i < encryptedBytes.length; i++) {
      result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
    }
    return Buffer.from(result).toString('utf8');
  } catch {
    return '';
  }
}
function simpleEncrypt(plainText, key) {
  const bytes = Buffer.from(plainText, 'utf8');
  const keyLength = key.length;
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i] ^ key.charCodeAt(i % keyLength));
  }
  return Buffer.from(out).toString('base64');
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    console.log('[PRINT-AREA-SPECS] Received request body:', body);

    // Accept either 'productId' from our frontend or 'catalog_product_id' for direct calls
    const catalog_product_id = body.productId || body.catalog_product_id;

    if (!catalog_product_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing product ID (productId or catalog_product_id)' }) };
    }

    console.log('[PRINT-AREA-SPECS] Getting print area specs for product:', catalog_product_id);

    // Get user authentication
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized - No token' }) };
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');

    // Verify JWT
    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.sub || decoded.id;
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized - Invalid token' }) };
    }

    // Get Printful OAuth token from Supabase (with refresh support)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printful_access_token_encrypted, printful_refresh_token_encrypted, printful_token_expires_at')
      .eq('id', userId)
      .single();

    if (userError || !user?.printful_access_token_encrypted) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'No Printful OAuth token found' }) };
    }

    let authToken = simpleDecrypt(user.printful_access_token_encrypted, process.env.JWT_SECRET);
    const refreshToken = user.printful_refresh_token_encrypted ? simpleDecrypt(user.printful_refresh_token_encrypted, process.env.JWT_SECRET) : null;
    const expiresAtIso = user.printful_token_expires_at || null;

    async function refreshAccessTokenIfNeeded(reason = '') {
      try {
        if (!refreshToken) return false;
        if (reason === 'preemptive') {
          if (!expiresAtIso) return false;
          const now = Date.now();
          const expiresMs = Date.parse(expiresAtIso);
          if (!expiresMs || (expiresMs - now) > 60_000) return false;
        }
        const form = new URLSearchParams();
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', refreshToken);
        form.set('client_id', process.env.PRINTFUL_CLIENT_ID);
        form.set('client_secret', process.env.PRINTFUL_CLIENT_SECRET);
        const tokenRes = await fetch('https://www.printful.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
        const tokenJson = await tokenRes.json().catch(()=>({}));
        if (!tokenRes.ok || !tokenJson?.access_token) return false;
        authToken = tokenJson.access_token;
        const newRefresh = tokenJson.refresh_token || refreshToken;
        const expiresAtUnix = tokenJson.expires_at ? parseInt(tokenJson.expires_at, 10) : null;
        const newExpiresIso = expiresAtUnix ? new Date(expiresAtUnix * 1000).toISOString() : null;
        await supabase
          .from('users')
          .update({
            printful_access_token_encrypted: simpleEncrypt(authToken, process.env.JWT_SECRET),
            printful_refresh_token_encrypted: newRefresh ? simpleEncrypt(newRefresh, process.env.JWT_SECRET) : user.printful_refresh_token_encrypted,
            printful_token_expires_at: newExpiresIso || user.printful_token_expires_at
          })
          .eq('id', userId);
        return true;
      } catch {
        return false;
      }
    }

    // Preemptive refresh
    await refreshAccessTokenIfNeeded('preemptive');

    // Call Printful Mockup Generator
    const apiUrl = `https://api.printful.com/mockup-generator/printfiles/${catalog_product_id}`;
    let response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });
    let data = await response.json().catch(()=>({}));
    console.log('[PRINT-AREA-SPECS] Printful printfiles API response:', { status: response.status, hasData: !!data });

    if (response.status === 401) {
      const refreshed = await refreshAccessTokenIfNeeded('forced');
      if (refreshed) {
        response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          }
        });
        data = await response.json().catch(()=>({}));
        console.log('[PRINT-AREA-SPECS] Retry printfiles API response:', { status: response.status });
      }
    }

    if (!response.ok) {
      return { 
        statusCode: response.status, 
        headers, 
        body: JSON.stringify({ 
          error: 'Printful API error', 
          details: data 
        }) 
      };
    }

    const r = data?.data || data?.result || data || {};
    const available = r?.available_placements || {};
    const printfiles = Array.isArray(r?.printfiles) ? r.printfiles : [];
    const variantMaps = Array.isArray(r?.variant_printfiles) ? r.variant_printfiles : [];

    const fileById = new Map();
    for (const f of printfiles) {
      if (f && (f.printfile_id != null)) fileById.set(f.printfile_id, f);
    }

    // Build placement specs from available_placements primarily, fallback to mapped printfiles
    const printAreaSpecs = [];
    for (const [placement, sizes] of Object.entries(available)) {
      if (String(placement).toLowerCase() === 'mockup') continue; // exclude synthetic placement
      let final_width_pixels = 0;
      let final_height_pixels = 0;
      let dpi = 300; // Default DPI

      // Find the corresponding printfile for this placement to get accurate DPI and fallbacks
      let printfile = null;
      if (variantMaps.length > 0) {
        const vm = variantMaps[0]; // Use the first variant as a representative
        const fid = vm?.placements?.[placement];
        if (fid != null) {
          printfile = fileById.get(fid);
        }
      }

      if (printfile) {
        dpi = printfile.dpi || dpi;
      }

      // Strategy 1: Use `print_area` dimensions (in pixels) if available in `available_placements`
      if (sizes?.print_area?.width && sizes?.print_area?.height) {
        final_width_pixels = sizes.print_area.width;
        final_height_pixels = sizes.print_area.height;
      } 
      // Strategy 2: Use `image` dimensions (in pixels) if available in `available_placements`
      else if (sizes?.image?.width && sizes?.image?.height) {
        final_width_pixels = sizes.image.width;
        final_height_pixels = sizes.image.height;
      } 
      // Strategy 3: Use the dimensions from the mapped printfile (in inches) and calculate pixels
      else if (printfile) {
        const width_in = printfile.width || 0;
        const height_in = printfile.height || 0;
        final_width_pixels = Math.round(width_in * dpi);
        final_height_pixels = Math.round(height_in * dpi);
      }
      // Strategy 4: Fallback to any width/height on the `sizes` object (could be inches) and calculate
      else if (sizes?.width && sizes?.height) {
        final_width_pixels = Math.round(sizes.width * dpi);
        final_height_pixels = Math.round(sizes.height * dpi);
      }

      printAreaSpecs.push({
        placement,
        technique: null,
        print_area: {
          width_inches: final_width_pixels / dpi,
          height_inches: final_height_pixels / dpi,
          dpi,
          width_pixels: final_width_pixels,
          height_pixels: final_height_pixels
        }
      });
    }

    const result = {
      success: true,
      catalog_product_id: parseInt(catalog_product_id, 10),
      product_name: r?.product_name || 'Unknown Product',
      print_area_specs: printAreaSpecs,
      total_placements: printAreaSpecs.length
    };

    console.log(`[PRINT-AREA-SPECS] Successfully processed product ${catalog_product_id}. Returning ${result.total_placements} placements.`);

    // The frontend is expecting a different shape, let's provide what it wants.
    // It expects { printAreas: [...] }
    const frontendResult = {
        success: true,
        printAreas: printAreaSpecs.map(spec => ({
            position: spec.placement,
            width: spec.print_area.width_pixels,
            height: spec.print_area.height_pixels
        }))
    };

    return { statusCode: 200, headers, body: JSON.stringify(frontendResult) };

  } catch (error) {
    console.error('[PRINT-AREA-SPECS] Error:', error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ 
        error: 'Failed to get print area specifications',
        details: error.message 
      }) 
    };
  }
};
