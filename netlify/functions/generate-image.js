// Compute a size family key so similar sizes can reuse the same image
function computeSizeFamily(w, h) {
  const ratio = w > 0 && h > 0 ? w / h : 1;
  // Bucket by rounded aspect ratio to 2 decimals and orientation
  const rounded = Math.round(ratio * 100) / 100; // e.g., 0.62, 1, 1.5
  const orientation = w === h ? 'square' : (w > h ? 'landscape' : 'portrait');
  return `${orientation}-ar-${rounded}`;
}

// netlify/functions/generate-image.js
// ONLY supports: fal-ai/nano-banana, fal-ai/nano-banana/edit, fal-ai/bria/background/remove
// All other models and fallbacks (like OpenAI) have been REMOVED as requested.

const FAL_ENDPOINTS = {
  'nano-banana': 'fal-ai/nano-banana',
  'nano-banana-edit': 'fal-ai/nano-banana/edit',
  'rembg': 'fal-ai/bria/background/remove' // Background removal
};

const jwt = require('jsonwebtoken');
const { getSupabase } = require('./_supabase_node');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return badRequest('Method not allowed', cors);
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      prompt,
      numImages = 1,
      size = '1024x1024',
      imageUrl,
      style,
      colors,
      audience,
      removeBackground = false
    } = body;
    // Background removal is only valid when we have an input image
    const effectiveRemoveBg = !!(removeBackground && imageUrl);
    // Normalize model to allowed set; default to nano-banana (use rembg ONLY if effectiveRemoveBg)
    let model = (body.model == null ? 'nano-banana' : String(body.model)).trim().toLowerCase();
    if (effectiveRemoveBg) model = 'rembg';
    if (!['nano-banana','nano-banana-edit','rembg'].includes(model)) {
      // Coerce any unknown model to a safe default
      model = 'nano-banana';
    }

    // Only require prompt for non-background removal operations
    if (!prompt && model !== 'rembg') return badRequest('Missing prompt', cors);

    // Validate allowed models only (after normalization)
    if (!FAL_ENDPOINTS[model]) {
      return badRequest(`Invalid model. Only allowed: ${Object.keys(FAL_ENDPOINTS).join(', ')}`, cors);
    }

    const [width, height] = size.split('x').map(Number);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
      return badRequest('Invalid size format. Use WxH (e.g. 1024x1024)', cors);
    }

    let enhancedPrompt = prompt.trim();
    // If the user wants transparent background but we don't have an image to run rembg on,
    // bias the generation prompt instead of using the rembg model.
    if (removeBackground && !imageUrl) {
      enhancedPrompt = `${enhancedPrompt} with transparent background, no background`;
    }
    
    // Inject strict design constraints so outputs work well across products
    const HARD_RULES = [
      'ABSOLUTE: transparent background only; never place blocks, rectangles or solid backdrops',
      'Edges must be organic/flowing/distressed/faded; avoid sharp 90-degree corners',
      'Design should look great on light and dark products (shirts, mugs, phone cases, etc.)',
      'Create unique, bold, eye-catching composition that works at thumbnail and poster sizes',
      'Prefer hand-drawn/organic borders, watercolor fades, distressed edges, curved line art',
      'Avoid generic clip-art, basic geometric frames, over-busy detail, tiny unreadable text',
      'Use colors that pop on multiple fabric/background colors; maintain contrast',
      'Vector-thinking: clean, scalable elements; central focus; natural outward flow'
    ].join('. ');

    // We append the rules briefly to keep prompts compact for the model
    enhancedPrompt = `${enhancedPrompt}. ${HARD_RULES}.`;

    // Frontend already handles style, colors, audience, and background removal in the prompt
    // No need to duplicate these in the backend

    enhancedPrompt = enhancedPrompt.slice(0, 1000);
    console.log(`generate-image -> model=${model} images=${numImages} size=${size}`);

    // Build a size-family key to allow reusing the same image for similar sizes
    const sizeFamily = computeSizeFamily(width, height);
    // For caching, treat removeBackground=false whenever it's prompt-only (no imageUrl)
    const isCacheEligible = (model === 'nano-banana') && !effectiveRemoveBg && !imageUrl;

    // If eligible, try to reuse a previously generated image for this user+prompt+model+size_family
    let userId = null;
    try {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const token = (authHeader || '').replace('Bearer ', '');
      if (token && process.env.JWT_SECRET) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = String(decoded.sub);
      }
    } catch (e) {
      console.log('JWT decode failed (cache still optional):', e.message);
    }

    if (isCacheEligible && userId) {
      try {
        const supabase = getSupabase(true);
        const { data: existing, error: selErr } = await supabase
          .from('generated_images')
          .select('id, image_url, metadata')
          .eq('user_id', userId)
          .eq('model', model)
          .eq('status', 'active')
          .eq('prompt', enhancedPrompt)
          .contains('metadata', { size_family: sizeFamily })
          .order('created_at', { ascending: false })
          .limit(1);
        if (!selErr && Array.isArray(existing) && existing.length > 0 && existing[0].image_url) {
          console.log(`Cache hit for size_family=${sizeFamily}. Reusing image.`);
          const imgUrl = existing[0].image_url;
          return ok({
            success: true,
            images: Array.from({ length: Math.max(1, Number(numImages) || 1) }, (_, i) => ({
              id: `cached-${existing[0].id}-${i}`,
              url: imgUrl,
              prompt: enhancedPrompt,
              width,
              height
            })),
            model
          }, cors);
        }
      } catch (e) {
        console.log('Cache select failed, proceeding to generate:', e.message);
      }
    }

    // Must have FAL_KEY
    if (!process.env.FAL_KEY) {
      return badRequest('FAL_KEY is not set in environment variables.', cors);
    }

    const result = await tryFal(enhancedPrompt, numImages, model, width, height, imageUrl, style, colors, audience, removeBackground);
    if (result.success) {
      // Best-effort usage logging (non-blocking)
      try {
        const authHeader = event.headers.authorization || event.headers.Authorization || '';
        const token = (authHeader || '').replace('Bearer ', '');
        if (!userId && token && process.env.JWT_SECRET) {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = String(decoded.sub);
        }
        if (userId) {
          const supabase = getSupabase(true);
          const count = Array.isArray(result.images) ? result.images.length : 1;
          const metadata = {
            source: 'generate-image',
            model,
            size,
            remove_background: !!effectiveRemoveBg
          };
          await supabase
            .from('usage_tracking')
            .insert([{ user_id: userId, type: 'ai_generations', count, metadata }]);
        } else {
          console.log('Skipping image usage log: missing token or JWT secret');
        }
      } catch (e) {
        console.log('Image AI usage logging failed:', e.message);
      }

      // Cache the first image for future reuse if eligible
      try {
        if (isCacheEligible && userId && Array.isArray(result.images) && result.images[0]?.url) {
          const supabase = getSupabase(true);
          const meta = {
            size_family: sizeFamily,
            width,
            height,
            style: style || null,
            colors: colors || null,
            audience: audience || null
          };
          await supabase.from('generated_images').insert([{
            user_id: userId,
            prompt: enhancedPrompt,
            image_url: result.images[0].url,
            printify_url: null,
            model,
            metadata: meta,
            status: 'active'
          }]);
        }
      } catch (e) {
        console.log('Cache insert failed (non-blocking):', e.message);
      }

      return ok(result, cors);
    }

    console.error('fal.ai failed:', result.error);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: result.error }) };

  } catch (err) {
    console.error('generate-image fatal error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: 'Internal server error' }) };
  }
};

// ───── tryFal: Only supports nano-banana, nano-banana-edit, rembg ─────
async function tryFal(prompt, numImages, modelKey, width, height, imageUrl, style, colors, audience, removeBackground) {
  const isNanoBanana = modelKey === 'nano-banana';
  const isNanoBananaEdit = modelKey === 'nano-banana-edit';
  const isRembg = modelKey === 'rembg';

  // === nano-banana or nano-banana-edit (queue-based) ===
  if (isNanoBanana || isNanoBananaEdit) {
    const basePath = isNanoBananaEdit
      ? 'fal-ai/nano-banana/edit'
      : 'fal-ai/nano-banana';
    const queueEndpoint = `https://queue.fal.run/${basePath}`;

    const requestBody = {
      prompt,
      num_images: numImages,
      image_size: { width, height },
      sync_mode: false
    };

    if (imageUrl) {
      requestBody.image_url = imageUrl; // Note: singular for nano-banana/edit
    }

    const res = await fetch(queueEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const initialData = await res.json().catch(() => ({}));
    if (!res.ok || !initialData.request_id) {
      return { success: false, error: initialData.message || 'Failed to queue request' };
    }

    // Poll for completion
    const { request_id: requestId } = initialData;
    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusRes = await fetch(`https://queue.fal.run/${basePath}/requests/${requestId}/status`, {
        headers: { 'Authorization': `Key ${process.env.FAL_KEY}` }
      });
      const status = await statusRes.json();

      if (status.status === 'COMPLETED') break;
      if (status.status === 'FAILED') {
        return { success: false, error: status.error?.message || 'Image generation failed' };
      }
      attempts++;
    }

    if (attempts >= maxAttempts) {
      return { success: false, error: 'Image generation timeout after 5 minutes' };
    }

    const resultRes = await fetch(`https://queue.fal.run/${basePath}/requests/${requestId}`, {
      headers: { 'Authorization': `Key ${process.env.FAL_KEY}` }
    });
    const data = await resultRes.json();

    if (resultRes.ok && Array.isArray(data.images)) {
      return {
        success: true,
        images: data.images.map((img, i) => ({
          id: `fal-${Date.now()}-${i}`,
          url: img.url,
          prompt,
          width: img.width || width,
          height: img.height || height
        })),
        model: modelKey
      };
    }

    return { success: false, error: data.message || 'Failed to retrieve generated images' };
  }

  // === rembg (bria background removal) ===
  if (isRembg) {
    if (!imageUrl) {
      return { success: false, error: 'Image URL is required for background removal' };
    }

    const res = await fetch('https://fal.run/fal-ai/bria/background/remove', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image_url: imageUrl })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.image?.url) {
      return { success: false, error: data.error || 'Background removal failed' };
    }

    return {
      success: true,
      images: [{
        id: `fal-${Date.now()}-0`,
        url: data.image.url,
        prompt: 'Background removed',
        width: data.image.width || width,
        height: data.image.height || height
      }],
      model: 'rembg'
    };
  }

  // Should never reach here due to pre-check
  return { success: false, error: 'Unsupported model' };
}

// ───── Helper Responses ─────
function ok(payload, cors) {
  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ success: true, ...payload })
  };
}

function badRequest(message, cors) {
  return {
    statusCode: 400,
    headers: cors,
    body: JSON.stringify({ success: false, error: message })
  };
}