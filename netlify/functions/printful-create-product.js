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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };

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
    const { title, description = '', catalog_product_id, selected_variant_ids, placement_files = [], retail_price } = body;
    if (!title || !catalog_product_id || !Array.isArray(selected_variant_ids) || selected_variant_ids.length === 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing required fields: title, catalog_product_id, selected_variant_ids' }) };
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
    };

    // Upload files first to obtain file_id(s)
    const uploaded = [];
    for (const f of placement_files) {
      if (!f || !f.image_url) continue;
      const res = await fetch('https://api.printful.com/files', {
        method: 'POST', headers: pfHeaders,
        body: JSON.stringify({ url: f.image_url })
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok || !data?.result?.id) {
        return { statusCode: res.status || 500, headers: cors, body: JSON.stringify({ success:false, error:'Failed to upload file to Printful', details: data }) };
      }
      uploaded.push({ placement: f.placement || 'front', file_id: data.result.id });
    }

    // Build sync variants: each selected variant gets the same files by placement
    const defaultPrice = retail_price != null ? String(retail_price) : undefined;
    const sync_variants = selected_variant_ids.map(vid => ({
      variant_id: Number(vid),
      ...(defaultPrice ? { retail_price: defaultPrice } : {}),
      files: uploaded.map(u => ({ type: 'default', file_id: u.file_id, placement: u.placement }))
    }));

    const payload = {
      sync_product: {
        name: title,
        ...(description ? { description } : {})
      },
      sync_variants,
      // optionally tie to catalog_product_id
      external_product_id: String(catalog_product_id)
    };

    const createRes = await fetch('https://api.printful.com/store/products', {
      method: 'POST', headers: pfHeaders, body: JSON.stringify(payload)
    });
    const createData = await createRes.json().catch(()=>({}));
    if (!createRes.ok || !createData?.result) {
      return { statusCode: createRes.status || 500, headers: cors, body: JSON.stringify({ success:false, error:'Failed to create Printful product', details: createData }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success:true, product: createData.result }) };
  } catch (err) {
    console.error('printful-create-product error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success:false, error:'Internal Server Error', details: err.message }) };
  }
};
