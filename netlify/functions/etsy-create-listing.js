// netlify/functions/etsy-create-listing.js
// Creates an Etsy listing from a Printful product design
// Expects JSON body:
// {
//   title: string (REQUIRED),
//   description?: string,
//   price: number (REQUIRED - in dollars),
//   quantity?: number (default: 1),
//   who_made?: 'i_did' | 'someone_else' | 'collective' (default: 'i_did'),
//   when_made?: '2020_2024' | 'made_to_order' | '2010_2019' | etc (default: '2020_2024'),
//   taxonomy_id?: number (default: 1),
//   image_urls?: string[],
//   shop_id: number (REQUIRED),
//   shipping_profile_id: number (REQUIRED for physical products),
//   processing_min?: number (default: 3 - business days),
//   processing_max?: number (default: 5 - business days),
//   type?: 'physical' | 'download' (default: 'physical'),
//   tags?: string[] (max 13),
//   materials?: string[] (max 13)
// }

const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Etsy-Token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  try {
    const ts = new Date().toISOString();
    console.log(`[etsy-create-listing] INVOKED ${ts}`, {
      method: event.httpMethod,
      path: event.path
    });

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: cors, body: '' };
    }

    if (event.httpMethod === 'GET') {
      return { 
        statusCode: 200, 
        headers: cors, 
        body: JSON.stringify({ success: true, message: 'etsy-create-listing is live', when: ts }) 
      };
    }

    if (event.httpMethod !== 'POST') {
      return { 
        statusCode: 405, 
        headers: cors, 
        body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) 
      };
    }

    // Verify app auth token if present (optional when X-Etsy-Token header is supplied)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const headerEtsyToken = event.headers['x-etsy-token'] || event.headers['X-Etsy-Token'];
    let userId = null;
    let token = null;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      token = authHeader.replace(/^Bearer\s+/i, '');
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.sub || decoded.id;
      } catch (e) {
        // ignore invalid app token if we have an explicit Etsy token header
        if (!headerEtsyToken) {
          return {
            statusCode: 401,
            headers: cors,
            body: JSON.stringify({ success: false, error: 'Unauthorized - Invalid token' })
          };
        }
      }
    } else if (!headerEtsyToken) {
      return {
        statusCode: 401,
        headers: cors,
        body: JSON.stringify({ success: false, error: 'Unauthorized - Missing Authorization or X-Etsy-Token' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const {
      title,
      description = '',
      price,
      quantity = 1,
      who_made = 'i_did',
      when_made = '2020_2024',
      taxonomy_id = 1,
      image_urls = [],
      shop_id,
      type = 'physical',
      is_supply = false,
      should_auto_renew = true,
      tags = [],
      materials = [],
      shipping_profile_id,
      shipping_profile_name,
      processing_min = 3,
      processing_max = 5
    } = body;

    console.log('[etsy-create-listing] Request body snapshot:', {
      title: title ? title.slice(0, 50) : undefined,
      price,
      quantity,
      shop_id,
      image_count: image_urls.length
    });

    if (!title || shop_id == null) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ success: false, error: 'Missing required fields: title, shop_id' })
      };
    }

    const numericPrice = Number(price);
    if (!numericPrice || numericPrice <= 0) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ success: false, error: 'Invalid price. Must be a number > 0.' })
      };
    }

    // Helper functions for encryption/decryption
    function simpleDecrypt(encryptedBase64, key) {
      const encryptedBytes = Buffer.from(encryptedBase64, 'base64');
      const keyLength = key.length;
      const result = [];
      for (let i = 0; i < encryptedBytes.length; i++) {
        result.push(encryptedBytes[i] ^ key.charCodeAt(i % keyLength));
      }
      return Buffer.from(result).toString('utf8');
    }

    function simpleEncrypt(text, key) {
      const keyLength = key.length;
      const result = [];
      for (let i = 0; i < text.length; i++) {
        result.push(text.charCodeAt(i) ^ key.charCodeAt(i % keyLength));
      }
      return Buffer.from(result).toString('base64');
    }

    // Get Etsy access token FIRST (before shipping profile resolution)
    let etsyAccessToken = headerEtsyToken || null;
    let etsyApiKey = null;

    if (!etsyAccessToken && userId) {
      // Get Etsy OAuth token from Supabase for the logged in user
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('etsy_access_token_encrypted, etsy_refresh_token_encrypted, etsy_token_expires_at, etsy_api_key')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        return {
          statusCode: 401,
          headers: cors,
          body: JSON.stringify({ success: false, error: 'User not found' })
        };
      }

      etsyAccessToken = user.etsy_access_token_encrypted ? simpleDecrypt(user.etsy_access_token_encrypted, process.env.JWT_SECRET) : null;
      etsyApiKey = user.etsy_api_key || process.env.ETSY_API_KEY;

      // Check if token is expired and refresh if needed
      const expiresAt = user.etsy_token_expires_at ? new Date(user.etsy_token_expires_at) : null;
      const isExpired = expiresAt ? expiresAt <= new Date() : false;

      if (isExpired && user.etsy_refresh_token_encrypted) {
        console.log('[etsy-create-listing] Access token expired, refreshing...');
        const refreshToken = simpleDecrypt(user.etsy_refresh_token_encrypted, process.env.JWT_SECRET);

        try {
          const refreshRes = await fetch('https://api.etsy.com/v3/public/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: etsyApiKey,
              refresh_token: refreshToken
            }).toString()
          });

          const refreshData = await refreshRes.json().catch(() => ({}));

          if (refreshRes.ok && refreshData.access_token) {
            console.log('[etsy-create-listing] Token refreshed successfully');
            etsyAccessToken = refreshData.access_token;
            const newRefreshToken = refreshData.refresh_token || refreshToken;
            const expiresIn = refreshData.expires_in || 3600;

            // Update tokens in database
            const encryptedToken = simpleEncrypt(etsyAccessToken, process.env.JWT_SECRET);
            const encryptedRefresh = simpleEncrypt(newRefreshToken, process.env.JWT_SECRET);

            await supabase
              .from('users')
              .update({
                etsy_access_token_encrypted: encryptedToken,
                etsy_refresh_token_encrypted: encryptedRefresh,
                etsy_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
              })
              .eq('id', userId);
          } else {
            console.error('[etsy-create-listing] Token refresh failed:', JSON.stringify(refreshData).slice(0, 500));
            return {
              statusCode: 401,
              headers: cors,
              body: JSON.stringify({
                success: false,
                error: 'Etsy token expired and refresh failed. Please re-authenticate.',
                details: refreshData
              })
            };
          }
        } catch (refreshErr) {
          console.error('[etsy-create-listing] Token refresh error:', refreshErr);
          return {
            statusCode: 401,
            headers: cors,
            body: JSON.stringify({
              success: false,
              error: 'Etsy token expired and refresh failed. Please re-authenticate.',
              details: refreshErr.message
            })
          };
        }
      }
    } else {
      etsyApiKey = process.env.ETSY_API_KEY;
    }

    if (!etsyAccessToken) {
      return {
        statusCode: 401,
        headers: cors,
        body: JSON.stringify({ success: false, error: 'Missing Etsy OAuth token' })
      };
    }

    // Resolve shipping profile and readiness state for physical products
    let resolvedShippingProfileId = shipping_profile_id;
    let resolvedReadinessStateId = null;

    if (type === 'physical') {
      // Fetch shipping profiles if not provided
      if (!resolvedShippingProfileId) {
        try {
          console.log('[etsy-create-listing] Fetching shipping profiles for shop:', shop_id);
          const profRes = await fetch(`https://api.etsy.com/v3/application/shops/${shop_id}/shipping-profiles`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${etsyAccessToken}`,
              'x-api-key': etsyApiKey,
              'Content-Type': 'application/json'
            }
          });
          const profData = await profRes.json().catch(() => ({}));
          if (profRes.ok) {
            const profiles = Array.isArray(profData?.results) ? profData.results
              : Array.isArray(profData?.shipping_profiles) ? profData.shipping_profiles
              : Array.isArray(profData?.data) ? profData.data : [];

            console.log('[etsy-create-listing] Found', profiles.length, 'shipping profiles');

            // If shipping_profile_name is provided, try to match it
            if (shipping_profile_name) {
              console.log('[etsy-create-listing] Resolving shipping profile by name:', shipping_profile_name);
              const match = profiles.find(p => {
                const title = String(p.title || p.name || '').toLowerCase();
                return title === String(shipping_profile_name).toLowerCase();
              }) || profiles.find(p => String(p.title || p.name || '').toLowerCase().includes(String(shipping_profile_name).toLowerCase()));
              if (match) {
                resolvedShippingProfileId = match.shipping_profile_id || match.id || match.profile_id;
                console.log('[etsy-create-listing] Resolved shipping_profile_id:', resolvedShippingProfileId);
              } else {
                console.warn('[etsy-create-listing] No shipping profile matched name:', shipping_profile_name);
              }
            }

            // If still no shipping profile, use the first one (default)
            if (!resolvedShippingProfileId && profiles.length > 0) {
              resolvedShippingProfileId = profiles[0].shipping_profile_id || profiles[0].id || profiles[0].profile_id;
              console.log('[etsy-create-listing] Using default (first) shipping profile:', resolvedShippingProfileId);
            }
          } else {
            console.warn('[etsy-create-listing] Failed to list shipping profiles:', JSON.stringify(profData).slice(0, 400));
          }
        } catch (e) {
          console.warn('[etsy-create-listing] Error resolving shipping profile:', e?.message || e);
        }
      }

      // Fetch or create readiness state (processing profile)
      try {
        console.log('[etsy-create-listing] Fetching readiness states for shop:', shop_id);
        const readinessRes = await fetch(`https://api.etsy.com/v3/application/shops/${shop_id}/readiness-state-definitions`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${etsyAccessToken}`,
            'x-api-key': etsyApiKey,
            'Content-Type': 'application/json'
          }
        });
        const readinessData = await readinessRes.json().catch(() => ({}));

        if (readinessRes.ok && readinessData?.results && readinessData.results.length > 0) {
          // Use existing "made_to_order" readiness state, or the first one available
          const madeToOrder = readinessData.results.find(r => r.readiness_state === 'made_to_order');
          const readyToShip = readinessData.results.find(r => r.readiness_state === 'ready_to_ship');
          const selectedState = madeToOrder || readyToShip || readinessData.results[0];

          resolvedReadinessStateId = selectedState.readiness_state_id;
          console.log('[etsy-create-listing] Using existing readiness_state_id:', resolvedReadinessStateId, '(', selectedState.readiness_state, ')');
        } else {
          // No readiness states exist, create one for "made_to_order"
          console.log('[etsy-create-listing] No readiness states found, creating "made_to_order" state...');
          const createParams = new URLSearchParams();
          createParams.append('readiness_state', 'made_to_order');
          createParams.append('min_processing_time', String(processing_min));
          createParams.append('max_processing_time', String(processing_max));
          createParams.append('processing_time_unit', 'business_days');

          const createRes = await fetch(`https://api.etsy.com/v3/application/shops/${shop_id}/readiness-state-definitions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${etsyAccessToken}`,
              'x-api-key': etsyApiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: createParams.toString()
          });

          const createData = await createRes.json().catch(() => ({}));
          if (createRes.ok && createData?.readiness_state_id) {
            resolvedReadinessStateId = createData.readiness_state_id;
            console.log('[etsy-create-listing] Created new readiness_state_id:', resolvedReadinessStateId);
          } else {
            console.error('[etsy-create-listing] Failed to create readiness state:', JSON.stringify(createData).slice(0, 400));
          }
        }
      } catch (e) {
        console.warn('[etsy-create-listing] Error resolving readiness state:', e?.message || e);
      }
    }

    // Validate required fields for physical products (after resolution)
    if (type === 'physical') {
      if (!resolvedShippingProfileId) {
        return {
          statusCode: 400,
          headers: cors,
          body: JSON.stringify({ success: false, error: 'Missing required field: shipping_profile_id (required for physical products). Could not auto-resolve from shop.' })
        };
      }
      if (!resolvedReadinessStateId) {
        return {
          statusCode: 400,
          headers: cors,
          body: JSON.stringify({ success: false, error: 'Missing required field: readiness_state_id (processing profile required for physical products). Could not auto-resolve from shop.' })
        };
      }
    }

    // Fetch or create return policy for custom/made-to-order items
    let resolvedReturnPolicyId = null;
    if (type === 'physical') {
      try {
        console.log('[etsy-create-listing] Fetching return policies for shop:', shop_id);
        const returnPoliciesRes = await fetch(`https://api.etsy.com/v3/application/shops/${shop_id}/policies/return`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${etsyAccessToken}`,
            'x-api-key': etsyApiKey,
            'Content-Type': 'application/json'
          }
        });
        const returnPoliciesData = await returnPoliciesRes.json().catch(() => ({}));

        if (returnPoliciesRes.ok && returnPoliciesData?.results && returnPoliciesData.results.length > 0) {
          // Use existing return policy (prefer "no returns" policy if exists)
          const noReturnsPolicy = returnPoliciesData.results.find(p =>
            p.accepts_returns === false ||
            String(p.name || '').toLowerCase().includes('no return') ||
            String(p.name || '').toLowerCase().includes('custom')
          );
          const selectedPolicy = noReturnsPolicy || returnPoliciesData.results[0];
          resolvedReturnPolicyId = selectedPolicy.return_policy_id;
          console.log('[etsy-create-listing] Using existing return_policy_id:', resolvedReturnPolicyId);
        } else {
          // Create a "no returns" policy for custom items
          console.log('[etsy-create-listing] No return policies found, creating no-returns policy...');
          const createPolicyParams = new URLSearchParams();
          createPolicyParams.append('accepts_returns', 'false');
          createPolicyParams.append('accepts_exchanges', 'false');

          const createPolicyRes = await fetch(`https://api.etsy.com/v3/application/shops/${shop_id}/policies/return`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${etsyAccessToken}`,
              'x-api-key': etsyApiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: createPolicyParams.toString()
          });

          const createPolicyData = await createPolicyRes.json().catch(() => ({}));
          if (createPolicyRes.ok && createPolicyData?.return_policy_id) {
            resolvedReturnPolicyId = createPolicyData.return_policy_id;
            console.log('[etsy-create-listing] Created new return_policy_id:', resolvedReturnPolicyId);
          } else {
            console.warn('[etsy-create-listing] Failed to create return policy:', JSON.stringify(createPolicyData).slice(0, 400));
          }
        }
      } catch (e) {
        console.warn('[etsy-create-listing] Error resolving return policy:', e?.message || e);
      }
    }

    const etsyHeaders = {
      'Authorization': `Bearer ${etsyAccessToken}`,
      'x-api-key': etsyApiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    // Step 1: Create draft listing
    console.log('[etsy-create-listing] Creating draft listing...');
    
    const listingParams = new URLSearchParams();
    listingParams.append('quantity', String(quantity));
    listingParams.append('title', title);
    listingParams.append('description', description || `${title} - Custom Design`);
    // Etsy v3 application endpoint accepts decimal price strings
    listingParams.append('price', numericPrice.toFixed(2));
    listingParams.append('who_made', who_made);
    listingParams.append('when_made', when_made);
    listingParams.append('taxonomy_id', String(taxonomy_id));
    listingParams.append('type', type);
    listingParams.append('is_supply', String(Boolean(is_supply)));
    listingParams.append('should_auto_renew', String(Boolean(should_auto_renew)));

    // Required for physical products
    if (type === 'physical') {
      listingParams.append('shipping_profile_id', String(resolvedShippingProfileId));
      listingParams.append('readiness_state_id', String(resolvedReadinessStateId));
      if (resolvedReturnPolicyId) {
        listingParams.append('return_policy_id', String(resolvedReturnPolicyId));
      }
    }

    if (Array.isArray(tags) && tags.length) {
      listingParams.append('tags', tags.slice(0, 13).join(','));
    }
    if (Array.isArray(materials) && materials.length) {
      listingParams.append('materials', materials.slice(0, 13).join(','));
    }

    const createListingRes = await fetch(
      `https://api.etsy.com/v3/application/shops/${shop_id}/listings`,
      {
        method: 'POST',
        headers: etsyHeaders,
        body: listingParams.toString()
      }
    );

    const createListingData = await createListingRes.json().catch(() => ({}));
    console.log('[etsy-create-listing] Create listing response status:', createListingRes.status);

    if (!createListingRes.ok) {
      console.error('[etsy-create-listing] Create listing failed:', JSON.stringify(createListingData).slice(0, 500));
      return { 
        statusCode: createListingRes.status || 500, 
        headers: cors, 
        body: JSON.stringify({ 
          success: false, 
          error: 'Failed to create Etsy listing', 
          details: createListingData 
        }) 
      };
    }

    const listingId = createListingData?.listing_id;
    if (!listingId) {
      console.warn('[etsy-create-listing] No listing_id in response:', JSON.stringify(createListingData).slice(0, 500));
      return { 
        statusCode: 400, 
        headers: cors, 
        body: JSON.stringify({ 
          success: false, 
          error: 'No listing ID returned from Etsy', 
          details: createListingData 
        }) 
      };
    }

    console.log('[etsy-create-listing] Draft listing created. Listing ID:', listingId);

    // Step 2: Upload images if provided
    let uploadedImageIds = [];
    if (Array.isArray(image_urls) && image_urls.length > 0) {
      console.log('[etsy-create-listing] Uploading', image_urls.length, 'images...');
      
      for (let i = 0; i < image_urls.length; i++) {
        const imageUrl = image_urls[i];
        if (!imageUrl) continue;

        try {
          console.log(`[etsy-create-listing] Uploading image ${i + 1}/${image_urls.length}...`);

          // Fetch image
          const imgRes = await fetch(imageUrl);
          if (!imgRes.ok) {
            console.warn(`[etsy-create-listing] Could not fetch image ${i + 1}:`, imgRes.status);
            continue;
          }

          const imgBuffer = await imgRes.buffer();

          // Create multipart form data
          const FormData = require('form-data');
          const formData = new FormData();

          // Determine file extension from URL or content-type
          const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          let extension = 'jpg';
          if (contentType.includes('png')) extension = 'png';
          else if (contentType.includes('gif')) extension = 'gif';
          else if (contentType.includes('webp')) extension = 'webp';

          formData.append('image', imgBuffer, {
            filename: `image_${i + 1}.${extension}`,
            contentType: contentType
          });

          // Upload to Etsy using multipart/form-data
          const uploadRes = await fetch(
            `https://api.etsy.com/v3/application/shops/${shop_id}/listings/${listingId}/images`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${etsyAccessToken}`,
                'x-api-key': etsyApiKey,
                ...formData.getHeaders()
              },
              body: formData
            }
          );

          const uploadData = await uploadRes.json().catch(() => ({}));
          console.log(`[etsy-create-listing] Image ${i + 1} upload status:`, uploadRes.status);

          if (uploadRes.ok && uploadData?.listing_image_id) {
            uploadedImageIds.push(uploadData.listing_image_id);
            console.log(`[etsy-create-listing] Image ${i + 1} uploaded. ID:`, uploadData.listing_image_id);
          } else {
            console.warn(`[etsy-create-listing] Image ${i + 1} upload failed:`, JSON.stringify(uploadData).slice(0, 300));
          }
        } catch (imgErr) {
          console.warn(`[etsy-create-listing] Error uploading image ${i + 1}:`, imgErr?.message);
        }
      }
    }

    console.log('[etsy-create-listing] Total images uploaded:', uploadedImageIds.length);

    // Step 3: Publish listing (set state to active)
    console.log('[etsy-create-listing] Publishing listing...');
    
    const publishParams = new URLSearchParams();
    publishParams.append('state', 'active');

    const publishRes = await fetch(
      `https://api.etsy.com/v3/application/shops/${shop_id}/listings/${listingId}`,
      {
        method: 'PATCH',
        headers: etsyHeaders,
        body: publishParams.toString()
      }
    );

    const publishData = await publishRes.json().catch(() => ({}));
    console.log('[etsy-create-listing] Publish response status:', publishRes.status);

    if (!publishRes.ok) {
      console.warn('[etsy-create-listing] Publish failed (non-fatal):', JSON.stringify(publishData).slice(0, 500));
      // Don't fail completely; listing is created as draft
    } else {
      console.log('[etsy-create-listing] Listing published successfully');
    }

    // Return success
    const response = {
      success: true,
      listing_id: listingId,
      listing_url: `https://www.etsy.com/listing/${listingId}`,
      images_uploaded: uploadedImageIds.length,
      published: publishRes.ok,
      shipping_profile_id: resolvedShippingProfileId, // Return this so frontend can cache it
      _debug: {
        listing_data: createListingData,
        image_ids: uploadedImageIds
      }
    };

    console.log('[etsy-create-listing] Returning success response:', JSON.stringify(response, null, 2));
    return { statusCode: 200, headers: cors, body: JSON.stringify(response) };

  } catch (err) {
    console.error('[etsy-create-listing] Error:', err);
    return { 
      statusCode: 500, 
      headers: cors, 
      body: JSON.stringify({ success: false, error: 'Internal Server Error', details: err.message }) 
    };
  }
};
