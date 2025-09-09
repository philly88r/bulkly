const fetch = require('node-fetch');
const FormData = require('form-data');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const { shopId, productId, imageUrl, position, append } = JSON.parse(event.body || '{}');
    if (!shopId || !productId || !imageUrl) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'shopId, productId, and imageUrl are required' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Authorization header required' }) };
    }

    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    const origin = `${proto}://${host}`;

    // 1) Fetch user Printify API key
    const apiKeyRes = await fetch(`${origin}/.netlify/functions/get-api-key`, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    if (!apiKeyRes.ok) {
      const text = await apiKeyRes.text();
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: `Failed to get API key: ${text}` }) };
    }
    const { apiKey } = await apiKeyRes.json();
    if (!apiKey) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'No API key found' }) };
    }

    // 2) Upload image to Printify library (by URL)
    let uploadJson;
    // Attempt 1: JSON body with { url, file_name }
    let uploadRes = await fetch('https://api.printify.com/v1/uploads/images.json', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: imageUrl, file_name: 'edited-image.png', filename: 'edited-image.png' })
    });

    if (!uploadRes.ok) {
      // Attempt 2: Fallback to multipart/form-data
      const form = new FormData();
      form.append('url', imageUrl);
      form.append('file_name', 'edited-image.png');
      form.append('filename', 'edited-image.png');
      uploadRes = await fetch('https://api.printify.com/v1/uploads/images.json', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...form.getHeaders(),
        },
        body: form
      });
      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        return { statusCode: uploadRes.status, headers, body: JSON.stringify({ success: false, error: `Image upload failed: ${text}` }) };
      }
    }

    uploadJson = await uploadRes.json();
    const uploadedId = uploadJson?.id || uploadJson?.file_id || uploadJson?.data?.id;
    if (!uploadedId) {
      return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Uploaded image ID not returned by Printify' }) };
    }

    // 3) Fetch existing product details
    const prodRes = await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!prodRes.ok) {
      const text = await prodRes.text();
      return { statusCode: prodRes.status, headers, body: JSON.stringify({ success: false, error: `Fetch product failed: ${text}` }) };
    }
    const product = await prodRes.json();

    // 4) Prepare updated print_areas payload
    const currentAreas = Array.isArray(product.print_areas) ? product.print_areas : [];
    if (currentAreas.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Product has no print_areas to update' }) };
    }

    // Find preferred area: matching position (e.g., 'front') if provided, else first area
    let targetIndex = 0;
    if (position) {
      const found = currentAreas.findIndex(a => Array.isArray(a.placeholders) && a.placeholders.some(ph => (ph.position || '').toLowerCase() === String(position).toLowerCase()));
      if (found >= 0) targetIndex = found;
    }

    const updatedAreas = currentAreas.map((area, idx) => {
      if (idx !== targetIndex) return area;
      const placeholders = Array.isArray(area.placeholders) ? area.placeholders : [];
      if (placeholders.length === 0) return area;

      // Update first placeholder's first image id while preserving transform props
      const ph = placeholders[0];
      const images = Array.isArray(ph.images) ? ph.images : [];
      const base = images[0] || {};
      const newImage = {
        id: uploadedId,
        x: typeof base.x === 'number' ? base.x : 0.5,
        y: typeof base.y === 'number' ? base.y : 0.5,
        scale: typeof base.scale === 'number' ? base.scale : 1.0,
        angle: typeof base.angle === 'number' ? base.angle : 0
      };
      const newImages = append ? [...images, newImage] : [newImage];

      return {
        ...area,
        placeholders: [{ ...ph, images: newImages }]
      };
    });

    // 5) PUT update product
    const putRes = await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ print_areas: updatedAreas })
    });

    if (!putRes.ok) {
      const text = await putRes.text();
      return { statusCode: putRes.status, headers, body: JSON.stringify({ success: false, error: `Update product failed: ${text}` }) };
    }

    const updatedProduct = await putRes.json();
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, product: updatedProduct, uploadedId }) };
  } catch (e) {
    console.error('apply-edited-image error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: e.message || 'Internal error' }) };
  }
};
