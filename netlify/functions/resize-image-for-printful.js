const sharp = require('sharp');
const fetch = require('node-fetch');
const { createResponse } = require('./_supabase_node');

exports.handler = async (event, context) => {
  console.log('[RESIZE-IMAGE] Function invoked');
  console.log('[RESIZE-IMAGE] Event method:', event.httpMethod);
  
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  try {
    // Parse request body
    console.log('[RESIZE-IMAGE] Event body:', event.body);
    const body = JSON.parse(event.body || '{}');
    const { 
      image_url, 
      target_width_pixels, 
      target_height_pixels,
      placement = 'front',
      maintain_aspect_ratio = false 
    } = body;

    if (!image_url || !target_width_pixels || !target_height_pixels) {
      return createResponse(400, { 
        error: 'Missing required parameters: image_url, target_width_pixels, target_height_pixels' 
      });
    }

    console.log('[RESIZE-IMAGE] Parameters:');
    console.log('  - image_url:', image_url);
    console.log('  - target_width_pixels:', target_width_pixels);
    console.log('  - target_height_pixels:', target_height_pixels);
    console.log('  - placement:', placement);
    console.log('  - maintain_aspect_ratio:', maintain_aspect_ratio);

    // Download the original image
    console.log('[RESIZE-IMAGE] Downloading original image...');
    const imageResponse = await fetch(image_url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`);
    }
    
    const imageBuffer = await imageResponse.buffer();
    console.log('[RESIZE-IMAGE] Downloaded image, size:', imageBuffer.length, 'bytes');

    // Get original image metadata
    const metadata = await sharp(imageBuffer).metadata();
    console.log('[RESIZE-IMAGE] Original image:', metadata.width, '×', metadata.height, 'pixels');

    let resizedBuffer;
    
    if (maintain_aspect_ratio) {
      // Resize maintaining aspect ratio, then pad/crop to exact dimensions
      console.log('[RESIZE-IMAGE] Resizing with aspect ratio preservation...');
      
      resizedBuffer = await sharp(imageBuffer)
        .resize(target_width_pixels, target_height_pixels, {
          fit: 'contain', // Fit within dimensions without cropping
          background: { r: 255, g: 255, b: 255, alpha: 0 } // Transparent background
        })
        .png() // Output as PNG to preserve transparency
        .toBuffer();
    } else {
      // Resize to exact dimensions (may distort aspect ratio)
      console.log('[RESIZE-IMAGE] Resizing to exact dimensions...');
      
      resizedBuffer = await sharp(imageBuffer)
        .resize(target_width_pixels, target_height_pixels, {
          fit: 'fill' // Stretch to exact dimensions
        })
        .png() // Output as PNG
        .toBuffer();
    }

    // Get resized image metadata
    const resizedMetadata = await sharp(resizedBuffer).metadata();
    console.log('[RESIZE-IMAGE] Resized image:', resizedMetadata.width, '×', resizedMetadata.height, 'pixels');

    // Verify the resize worked correctly
    if (resizedMetadata.width !== target_width_pixels || resizedMetadata.height !== target_height_pixels) {
      console.warn('[RESIZE-IMAGE] Warning: Actual dimensions do not match target!');
      console.warn('Target:', target_width_pixels, '×', target_height_pixels);
      console.warn('Actual:', resizedMetadata.width, '×', resizedMetadata.height);
    }

    // Convert to base64 for response
    const base64Image = resizedBuffer.toString('base64');
    const dataUri = `data:image/png;base64,${base64Image}`;

    console.log('[RESIZE-IMAGE] Resize complete, output size:', resizedBuffer.length, 'bytes');
    console.log('[RESIZE-IMAGE] Final dimensions:', resizedMetadata.width, '×', resizedMetadata.height);

    const response = {
      success: true,
      original_dimensions: {
        width: metadata.width,
        height: metadata.height
      },
      target_dimensions: {
        width: target_width_pixels,
        height: target_height_pixels
      },
      actual_dimensions: {
        width: resizedMetadata.width,
        height: resizedMetadata.height
      },
      resized_image_data_uri: dataUri,
      file_size_bytes: resizedBuffer.length,
      placement: placement,
      resize_successful: resizedMetadata.width === target_width_pixels && resizedMetadata.height === target_height_pixels
    };

    return createResponse(200, response);

  } catch (error) {
    console.error('[RESIZE-IMAGE] Error:', error);
    return createResponse(500, { 
      error: 'Failed to resize image',
      details: error.message 
    });
  }
};
