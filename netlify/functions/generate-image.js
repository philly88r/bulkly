// netlify/functions/generate-image.js
// Netlify function for AI image generation with fal.ai integration

exports.handler = async (event) => {
    /* ───── CORS ───── */
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  
    try {
      const { prompt, numImages = 1, model = 'flux-dev', size = '1024x1024' } = JSON.parse(event.body || '{}');
      if (!prompt) return badRequest('Missing prompt');
  
      const sanitizedPrompt = prompt.trim().slice(0, 1000);
      const [width, height] = size.split('x').map(Number);
      console.log(`Generating ${numImages} image(s) with model: ${model}`);
  
      /* ───── fal.ai (primary) ───── */
      if (process.env.FAL_KEY) {
        try {
          const falResult = await generateWithFal(sanitizedPrompt, numImages, model, width, height);
          if (falResult.success) return ok(falResult);
        } catch (falError) {
          console.error('fal.ai error:', falError);
        }
      }
  
      /* ───── OpenAI (fallback) ───── */
      if (process.env.OPENAI_API_KEY) {
        try {
          const openRes = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              prompt: sanitizedPrompt,
              n: numImages,
              size,
              quality: 'standard'
            })
          });
          const openData = await openRes.json();
          if (openRes.ok) {
            const images = openData.data.map((img, i) => ({
              id: `openai-${Date.now()}-${i}`,
              url: img.url,
              prompt: sanitizedPrompt,
              width,
              height,
              source: 'OpenAI DALL-E'
            }));
            return ok({ images }, 'OpenAI DALL-E');
          }
        } catch (err) {
          console.error('OpenAI error:', err);
        }
      }
  
      /* ───── Placeholder (last resort) ───── */
      return ok(makePlaceholders(sanitizedPrompt, numImages, width, height), 'Placeholder',
                'Using placeholder images – add FAL_KEY or OPENAI_API_KEY for real AI generation.');
  
    } catch (err) {
      console.error('Image generation error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
    }
  
    /* helpers */
    function ok(payload, source = payload.source, note) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...payload, source, note }) };
    }
    function badRequest(msg) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: msg }) };
    }
  };
  
  /* ───────────────────────────────────────────── */
  
  const MODEL_ENDPOINTS = {
    'flux-dev':     'fal-ai/flux/dev',
    'flux-schnell': 'fal-ai/flux/schnell',
    'flux-pro':     'fal-ai/flux-pro',
    'recraft-v3':   'fal-ai/recraft-v3',
    'ideogram-v2':  'fal-ai/ideogram-v2',
    'flux-lora':    'fal-ai/flux/dev/lora'
  };
  
  async function generateWithFal(prompt, numImages, modelKey, width, height) {
    const selectedModel = MODEL_ENDPOINTS[modelKey] || MODEL_ENDPOINTS['flux-dev'];
    const body = {
      prompt: enhancePromptForPOD(prompt, modelKey),
      image_size: { width, height },     // <-- FIX: always object
      num_images: numImages,
      guidance_scale: 7.5,
      num_inference_steps: modelKey === 'flux-schnell' ? 4 : 28,
      seed: Math.floor(Math.random() * 1e6),
      enable_safety_checker: true,
      format: 'png',
      transparent: true
    };
  
    const res = await fetch(`https://fal.run/${selectedModel}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
  
    if (res.ok && Array.isArray(data.images)) {
      return {
        success: true,
        images: data.images.map((img, i) => ({
          id: `fal-${Date.now()}-${i}`,
          url: img.url,
          prompt: body.prompt,
          width: img.width || width,
          height: img.height || height,
          source: `fal.ai ${modelKey}`
        }))
      };
    }
    throw new Error(data.detail || data.error || 'fal.ai generation failed');
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
    
    // Add transparent background instruction without showing it in the prompt
    const transparentInstruction = 'transparent background, no background, isolated object, ';
    return `${style}${transparentInstruction}high quality, detailed, professional, print ready, 300 DPI quality, commercial use, ${prompt}`;
  }