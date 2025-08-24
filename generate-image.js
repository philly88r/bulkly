// netlify/functions/generate-image.js
// Generates imagery with fal.ai (primary) or OpenAI DALL-E (fallback).

const FAL_ENDPOINTS = {
    'flux-dev':     'fal-ai/flux/dev',
    'flux-schnell': 'fal-ai/flux/schnell',
    'flux-pro':     'fal-ai/flux-pro/v1.1',
    'recraft-v3':   'fal-ai/recraft-v3',
    'ideogram-v2':  'fal-ai/ideogram-v2',
    'flux-lora':    'fal-ai/flux/dev/lora',
    'imagen4-preview': 'fal-ai/imagen4/preview'
  };
  
  exports.handler = async (event) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };
  
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 200, headers: cors, body: '' };
  
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  
    try {
      const { prompt, numImages = 1, model = 'flux-dev', size = '1024x1024' } = JSON.parse(event.body || '{}');
      if (!prompt) return badRequest('Missing prompt');
  
      const [width, height] = size.split('x').map(Number);
      const enhancedPrompt = `${prompt.trim()}, transparent background, no background, white background removed, isolated subject, cutout style, transparent PNG, remove all background elements, subject only on transparent background`.slice(0, 1000);
      console.log(`generate-image -> model=${model} images=${numImages} size=${size}`);
  
      /* ──────── fal.ai (primary) ──────── */
      if (process.env.FAL_KEY) {
        const fal = await tryFal(enhancedPrompt, numImages, model, width, height);
        if (fal.success) return ok(fal);
        console.warn('fal.ai failed, falling back:', fal.error);
      } else {
        console.warn('FAL_KEY missing – skipping fal.ai');
      }

      /* ──────── OpenAI (fallback) ──────── */
      if (process.env.OPENAI_API_KEY) {
        const openai = await tryOpenAI(enhancedPrompt, numImages, width, height);
        if (openai.success) return ok(openai);
        console.warn('OpenAI failed, falling back:', openai.error);
      }

      /* ──────── Placeholder (last resort) ──────── */
      return ok(makePlaceholders(enhancedPrompt, numImages, width, height), 'Placeholder',
                'Using placeholder images. Add FAL_KEY or OPENAI_API_KEY to environment variables for real AI generation.');
  
    } catch (err) {
      console.error('generate-image fatal error:', err);
      return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
    }
  
    /* helper responses */
    function ok(payload, source = payload.source, note) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, ...payload, source, note }) };
    }
    function badRequest(msg) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: msg }) };
    }
  };
  
  /* ─────────────────────────────────────────────────────────── */
  
  async function tryFal(prompt, numImages, modelKey, width, height) {
    const model = FAL_ENDPOINTS[modelKey] || FAL_ENDPOINTS['flux-dev'];
    const body = {
      prompt: enhancePromptForPOD(prompt, modelKey),
      negative_prompt: "background, white background, colored background, solid background, backdrop, scenery, environment, room, wall, floor, surface, gradient background, textured background",
      image_size: { width, height },
      num_images: numImages,
      guidance_scale: 7.5,
      num_inference_steps: modelKey === 'flux-schnell' ? 4 : 28,
      seed: Math.floor(Math.random() * 1e6),
      enable_safety_checker: true,
      format: 'png',
      output_format: 'png'
    };
  
    const res = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
  
    if (res.ok && Array.isArray(json.images)) {
      return {
        success: true,
        images: json.images.map((img, i) => ({
          id: `fal-${Date.now()}-${i}`,
          url: img.url,
          prompt: body.prompt,
          width: img.width || width,
          height: img.height || height
        })),
        model
      };
    }
    return { success: false, error: json.detail || json.error || 'Unknown fal.ai error', model };
  }
  
  async function tryOpenAI(prompt, numImages, width, height) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, n: numImages, size: `${width}x${height}`, quality: 'standard' })
    });
    const json = await res.json().catch(() => ({}));
  
    if (res.ok && Array.isArray(json.data)) {
      return {
        success: true,
        images: json.data.map((img, i) => ({
          id: `openai-${Date.now()}-${i}`,
          url: img.url,
          prompt,
          width,
          height
        }))
      };
    }
    return { success: false, error: json.error?.message || res.statusText };
  }
  
  function makePlaceholders(prompt, numImages, width, height) {
    const colors = ['FF6B6B', '4ECDC4', '45B7D1', '96CEB4', 'FFEAA7', 'DDA0DD'];
    const encoded = encodeURIComponent(prompt.slice(0, 30));
    return {
      images: Array.from({ length: numImages }, (_, i) => ({
        id: `placeholder-${Date.now()}-${i}`,
        url: `https://via.placeholder.com/${width}x${height}/${colors[i % colors.length]}/FFFFFF?text=${encoded}`,
        prompt,
        width,
        height
      }))
    };
  }
  
  /* ───── Prompt helper ───── */
  function enhancePromptForPOD(prompt, model) {
    const style = {
      'recraft-v3': 'vector art style, clean design, professional branding, ',
      'ideogram-v2': 'logo design, typography focus, commercial use, ',
      'flux-dev': 'high resolution, print quality, commercial design, ',
      'flux-pro': 'premium quality, professional design, commercial use, ',
      'flux-schnell': 'clean design, print ready, '
    }[model] || 'print-on-demand design, ';
    return `${style}high quality, detailed, professional, clean background, print ready, 300 DPI quality, commercial use, ${prompt}`;
  }