// netlify/functions/printful-create-product.js
// Creates a Printful store product from catalog product + assigned design files.
// Expects JSON body:
// {
//   title: string,
//   description?: string,
//   catalog_product_id: number,
//   selected_variant_ids: number[],
//   placement_files: [{ placement: 'front'|'back'|'left'|'right'|'sleeve_left'|'sleeve_right'|string, image_url: string }],
//   retail_price?: string | number  // e.g. '24.99'
// }
// Returns { success: true, product } on success.

const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Lightweight image size detection (PNG/JPEG) from Buffer to avoid native deps like sharp
function detectImageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    // PNG signature 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      // IHDR chunk starts at offset 8+8; width/height are 4-byte big-endian at offsets 16 and 20
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width && height) return { width, height, format: 'png' };
    }
    // JPEG start of image FF D8
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xFF) { offset++; continue; }
        const marker = buf[offset + 1];
        const length = buf.readUInt16BE(offset + 2);
        // SOF0 (0xC0) or SOF2 (0xC2) contain size
        if (marker === 0xC0 || marker === 0xC2) {
          if (offset + 7 + 2 < buf.length) {
            const height = buf.readUInt16BE(offset + 5);
            const width = buf.readUInt16BE(offset + 7);
            if (width && height) return { width, height, format: 'jpeg' };
          }
          break;
        }
        if (length <= 2) break; // avoid infinite loop on corrupt data
        offset += 2 + length;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

exports.handler = async (event) => {
  try {
    // Verbose entry log for ALL methods so you can see logs in Netlify even on GET
    const ts = new Date().toISOString();
    const snapshotHeaders = {
      host: event.headers.host,
      'user-agent': event.headers['user-agent'],
      referer: event.headers.referer,
      origin: event.headers.origin,
    };
    console.log(`[printful-create-product] INVOKED ${ts}`, {
      method: event.httpMethod,
      path: event.path,
      query: event.queryStringParameters,
      headers: snapshotHeaders,
      bodyBytes: (event.body ? Buffer.byteLength(event.body, 'utf8') : 0)
    });

    if (event.httpMethod === 'OPTIONS') {
      console.log('[printful-create-product] CORS preflight responded 200');
      return { statusCode: 200, headers: cors, body: '' };
    }

    // Health/diagnostic endpoint for quick logging from the browser
    if (event.httpMethod === 'GET') {
      console.log('[printful-create-product] GET health check');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success:true, message:'printful-create-product is live', when: ts }) };
    }

    if (event.httpMethod !== 'POST') {
      console.log('[printful-create-product] Method not allowed:', event.httpMethod);
      return { statusCode: 405, headers: cors, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };
    }
  } catch (e) {
    // In case logging itself throws
    console.error('[printful-create-product] Early error before routing:', e);
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success:false, error:'Unauthorized - No token' }) };
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');

    let userId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.sub || decoded.id;
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success:false, error:'Unauthorized - Invalid token' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { title, description = '', catalog_product_id, placement_files = [], retail_price, store_id, initial_images } = body;
    try {
      const snapshot = {
        title: title ? String(title).slice(0,120) : undefined,
        catalog_product_id,
        retail_price,
        store_id,
        placement_files_count: Array.isArray(placement_files) ? placement_files.length : 0,
      };
      console.log('[printful-create-product] Parsed body snapshot:', snapshot);
    } catch(_) {}
    let { selected_variant_ids } = body;
    if (!title || !catalog_product_id) {
      console.warn('[printful-create-product] Missing title or catalog_product_id');
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing required fields: title, catalog_product_id' }) };
    }

    // Get Printful OAuth token from Supabase (public app, OAuth-only)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('printful_access_token_encrypted')
      .eq('id', userId)
      .single();

    if (userError || !user || !user.printful_access_token_encrypted) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success:false, error:'Printful OAuth not connected for this user. Connect via Dashboard → Settings.' }) };
    }

    function simpleDecrypt(encryptedBase64, key) {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyLength = key.length;
      const result = [];
      for (let i = 0; i < encryptedBytes.length; i++) {
        result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
      }
      return Buffer.from(result).toString('utf8');
    }

    const authToken = user.printful_access_token_encrypted ? simpleDecrypt(user.printful_access_token_encrypted, process.env.JWT_SECRET) : null;
    if (!authToken) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ success:false, error:'Failed to decrypt Printful OAuth token.' }) };
    }

    const pfHeaders = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
      // Using OAuth - no store ID header needed
    };

    // If no selected_variant_ids were provided, derive from catalog product
    if (!Array.isArray(selected_variant_ids) || selected_variant_ids.length === 0) {
      try {
        // Attempt v2 with selling region support
        const sellingRegion = body.selling_region || 'united_states';
        const urlV2 = `https://api.printful.com/v2/catalog-products/${Number(catalog_product_id)}?selling_region=${sellingRegion}`;
        console.log('[printful-create-product] Deriving variants via v2:', urlV2);
        let res = await fetch(urlV2, { headers: pfHeaders });
        let data = await res.json().catch(()=>({}));
        let variants = Array.isArray(data?.data?.variants) ? data.data.variants : [];
        if (!res.ok || !data?.data) {
          console.warn('[printful-create-product] v2 derive failed. Status:', res.status, 'Body snapshot:', JSON.stringify(data).slice(0,500));
        }
        if (variants.length === 0) {
          // Fallback to legacy catalog endpoint
          const urlV1 = `https://api.printful.com/products/${Number(catalog_product_id)}`;
          console.log('[printful-create-product] v2 returned 0 variants; trying v1:', urlV1);
          res = await fetch(urlV1, { headers: pfHeaders });
          data = await res.json().catch(()=>({}));
          const v1vars = Array.isArray(data?.result?.variants) ? data.result.variants : [];
          variants = v1vars;
          if (!res.ok) console.warn('[printful-create-product] v1 fetch status:', res.status, 'body snapshot:', JSON.stringify(data).slice(0,500));
        }
        // If still no variants, try mockup-generator printfiles (variant_printfiles[].variant_id)
        if (!variants || variants.length === 0) {
          const urlPF = `https://api.printful.com/mockup-generator/printfiles/${Number(catalog_product_id)}`;
          console.log('[printful-create-product] Catalog endpoints returned 0; trying printfiles:', urlPF);
          res = await fetch(urlPF, { headers: pfHeaders });
          data = await res.json().catch(()=>({}));
          const vpf = Array.isArray(data?.result?.variant_printfiles) ? data.result.variant_printfiles : (Array.isArray(data?.variant_printfiles) ? data.variant_printfiles : []);
          const ids = vpf.map(v => v && (v.variant_id || v.variantId)).filter(Boolean);
          variants = ids.map(id => ({ id }));
          if (!res.ok) console.warn('[printful-create-product] printfiles fetch status:', res.status, 'body snapshot:', JSON.stringify(data).slice(0,500));
        }
        selected_variant_ids = (variants || []).map(v => v.id || v.variant_id).filter(Boolean);
        console.log('[printful-create-product] Derived variant ids count:', selected_variant_ids.length);
      } catch (e) {
        console.error('[printful-create-product] Exception deriving variants:', e && e.message);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ success:false, error:'Exception deriving variants from catalog', details: e.message }) };
      }
    }

    if (!Array.isArray(selected_variant_ids) || selected_variant_ids.length === 0) {
      console.warn('[printful-create-product] No variants available for this catalog product after derivation');
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'No variants available for this catalog product' }) };
    }

    // Use Step 2 dimensions directly; do not re-fetch or resize here
    const uploaded = [];
    const uploadedDebug = [];
    try {
      console.log('[printful-create-product] Using client-provided printfile sizes from Step 2');
    } catch(_) {}
    
    for (const f of placement_files) {
      if (!f || !f.image_url) {
        console.log('Skipping invalid placement file:', f);
        continue;
      }
      // Expect width/height/dpi to be provided by the UI (Step 2)
      const w = Number(f.width) || null;
      const h = Number(f.height) || null;
      const dpi = Number(f.dpi) || 300;
      console.log(`[printful-create-product] FILE SPEC RECEIVED: ${f.placement || 'front'} -> ${f.image_url} | ${w}x${h} @ ${dpi} DPI`);

      // Fetch actual image and log its real dimensions for traceability
      try {
        const dbg = { placement: f.placement || 'front', step2: { width: w, height: h, dpi }, actual: null, uploaded_file_id: null };
        const headUrl = f.image_url.trim();
        const imgRes = await fetch(headUrl);
        if (!imgRes.ok) {
          console.warn('[printful-create-product] Could not download image to inspect size:', imgRes.status, imgRes.statusText);
        } else {
          const buf = await imgRes.buffer();
          const meta = detectImageSize(buf);
          if (meta && meta.width && meta.height) {
            console.log(`[printful-create-product] ACTUAL IMAGE DIMENSIONS: ${meta.width}x${meta.height} fmt=${meta.format || 'unknown'}`);
            if (w && h && (meta.width !== w || meta.height !== h)) {
              console.warn(`[printful-create-product] SIZE MISMATCH: Step2=${w}x${h} vs Actual=${meta.width}x${meta.height}`);
            }
            dbg.actual = { width: meta.width, height: meta.height, format: meta.format || null };
          } else {
            console.warn('[printful-create-product] Failed to detect image dimensions from buffer');
          }
        }
        uploadedDebug.push(dbg);
      } catch (e) {
        console.warn('[printful-create-product] Error fetching image for metadata:', e && e.message);
      }
      try {
        const uploadRes = await fetch('https://api.printful.com/files', {
          method: 'POST',
          headers: pfHeaders,
          body: JSON.stringify({ url: f.image_url.trim() })
        });
        const uploadData = await uploadRes.json().catch(()=>({}));
        if (!uploadRes.ok || !uploadData?.result?.id) {
          console.warn('[printful-create-product] File upload failed', uploadRes.status, JSON.stringify(uploadData).slice(0,400));
          return { 
            statusCode: uploadRes.status || 500, 
            headers: cors, 
            body: JSON.stringify({ 
              success: false, 
              error: 'Failed to upload file to Printful', 
              details: uploadData
            }) 
          };
        }
        uploaded.push({ placement: f.placement || 'front', file_id: uploadData.result.id });
        try {
          const last = uploadedDebug[uploadedDebug.length - 1];
          if (last && !last.uploaded_file_id) last.uploaded_file_id = uploadData.result.id;
        } catch(_) {}
        console.log(`[printful-create-product] Uploaded: ${f.placement || 'front'} -> ${uploadData.result.id}`);

        // Fetch Printful file info for final confirmation of stored dimensions
        try {
          const infoRes = await fetch(`https://api.printful.com/files/${encodeURIComponent(String(uploadData.result.id))}`, {
            headers: pfHeaders
          });
          const infoData = await infoRes.json().catch(()=>({}));
          if (infoRes.ok && infoData?.result) {
            const pf = infoData.result;
            console.log(`[printful-create-product] PRINTFUL FILE INFO: id=${pf.id} size=${pf.width}x${pf.height} dpi=${pf.dpi || 'n/a'} type=${pf.type || 'file'}`);
            try {
              const last = uploadedDebug[uploadedDebug.length - 1];
              if (last) last.printful_file = { width: pf.width, height: pf.height, dpi: pf.dpi || null, type: pf.type || null };
            } catch(_) {}
          } else {
            console.warn('[printful-create-product] Could not fetch Printful file info for id', uploadData.result.id, 'status', infoRes.status);
          }
        } catch (e) {
          console.warn('[printful-create-product] Error fetching Printful file info:', e && e.message);
        }
      } catch (error) {
        console.error('[printful-create-product] Error uploading file:', error?.message || error);
        return { 
          statusCode: 500, 
          headers: cors, 
          body: JSON.stringify({ 
            success: false, 
            error: 'Exception during file upload', 
            details: error.message
          }) 
        };
      }
    }

    // Build sync variants: each selected variant gets the same files by placement
    const defaultPrice = retail_price != null ? String(retail_price) : undefined;
    
    // Ensure we have files to assign to variants
    if (uploaded.length === 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing placement files', details: 'No valid files were uploaded to Printful' }) };
    }
    
    // Map placement to Printful file "type" exactly (e.g., 'front', 'back', 'embroidery_front', etc.)
    function placementToType(p) {
      const v = String(p || '').toLowerCase();
      if (!v) return 'default';
      // Common mappings
      const map = {
        'front': 'front',
        'back': 'back',
        'left': 'left',
        'right': 'right',
        'sleeve_left': 'sleeve_left',
        'sleeve_right': 'sleeve_right',
        'label_inside': 'label_inside',
        'label_outside': 'label_outside',
        'mockup': 'mockup'
      };
      if (map[v]) return map[v];
      // Embroidery prefixed placements
      if (v.startsWith('embroidery_')) return v; // already a correct type
      return v; // fallback: use placement as type value
    }

    const sync_variants = selected_variant_ids.map(vid => ({
      variant_id: Number(vid),
      ...(defaultPrice ? { retail_price: defaultPrice } : {}),
      files: uploaded.map(u => ({ type: placementToType(u.placement), id: u.file_id }))
    }));
    try {
      console.log('[printful-create-product] sync_variants count:', sync_variants.length, 'files per variant:', (sync_variants[0]?.files||[]).length);
    } catch(_) {}
    
    // Validate that we have variants with files
    if (sync_variants.length === 0 || sync_variants.some(v => !v.files || v.files.length === 0)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Invalid variant configuration', details: 'Each variant must have at least one file assigned' }) };
    }

    const payload = {
      sync_product: {
        name: title,
        ...(description ? { description } : {})
      },
      sync_variants,
      // optionally tie to catalog_product_id
      external_product_id: String(catalog_product_id)
    };
    try {
      console.log('[printful-create-product] Creating product with payload snapshot:', {
        name: payload.sync_product.name,
        variants: payload.sync_variants.length,
        filesFirstVariant: (payload.sync_variants[0]?.files||[]).length
      });
    } catch(_) {}

    const createRes = await fetch('https://api.printful.com/store/products', {
      method: 'POST', headers: pfHeaders, body: JSON.stringify(payload)
    });
    const createData = await createRes.json().catch(()=>({}));
    console.log('[printful-create-product] Create response status:', createRes.status, 'has result:', !!createData?.result);
    if (!createRes.ok || !createData?.result) {
      console.warn('[printful-create-product] Create failed. Body snapshot:', JSON.stringify(createData).slice(0,1000));
      return { statusCode: createRes.status || 500, headers: cors, body: JSON.stringify({ success:false, error:'Failed to create Printful product', details: createData }) };
    }

    // Optional: set initial gallery images immediately after creation.
    // Use provided initial_images (URLs) if present; else fall back to placement_files image URLs.
    try {
      const pid = createData?.result?.id;
      const imageSrcs = [];
      if (Array.isArray(initial_images) && initial_images.length) {
        initial_images.forEach(u => { if (typeof u === 'string' && u.trim()) imageSrcs.push(u.trim()); });
      } else if (Array.isArray(placement_files) && placement_files.length) {
        placement_files.forEach(pf => { const u = pf && (pf.image_url || pf.url); if (typeof u === 'string' && u.trim()) imageSrcs.push(u.trim()); });
      }
      // Deduplicate and clamp to 12
      const uniq = Array.from(new Set(imageSrcs)).slice(0, 12);
      if (pid && uniq.length) {
        const payloadImages = { sync_product: { images: uniq.map((u) => ({ src: u })) } };
        console.log('[printful-create-product] Setting initial images via PUT /store/products/', pid, 'count:', uniq.length);
        const putRes = await fetch(`https://api.printful.com/store/products/${encodeURIComponent(String(pid))}`, {
          method: 'PUT', headers: pfHeaders, body: JSON.stringify(payloadImages)
        });
        const putData = await putRes.json().catch(()=>({}));
        console.log('[printful-create-product] Images PUT status:', putRes.status, 'ok:', putRes.ok);
        if (!putRes.ok) {
          console.warn('[printful-create-product] Failed to set initial images (non-fatal):', JSON.stringify(putData).slice(0,800));
        } else {
          // Optionally merge returned product if present
          try {
            if (putData?.result) {
              createData.result = putData.result; // reflect latest product state
            }
          } catch(_) {}
        }
      } else {
        console.log('[printful-create-product] No initial images to set or missing product id. Skipping images PUT.');
      }
    } catch (imgErr) {
      console.warn('[printful-create-product] Initial images step failed (non-fatal):', imgErr?.message || imgErr);
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success:true, product: createData.result, _debug: { uploaded: uploadedDebug } }) };
  } catch (err) {
    console.error('printful-create-product error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success:false, error:'Internal Server Error', details: err.message }) };
  }
};
