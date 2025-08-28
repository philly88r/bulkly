// Save AI-generated images to Supabase
const { getSupabase } = require('./_supabase_node.js');

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { images, userId } = body;

    if (!images || !Array.isArray(images)) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid images data' }) };
    }

    const supabase = getSupabase(true);
    
    // Save each image individually for maximum flexibility
    const savedImages = [];
    
    for (const image of images) {
      const { data, error } = await supabase
        .from('generated_images')
        .insert([
          {
            user_id: userId,
            product_id: image.productId || null,
            prompt: image.prompt || '',
            image_url: image.imageUrl || image.printifyUrl || '',
            printify_url: image.printifyUrl || '',
            model: image.model || 'unknown',
            metadata: {
              originalPrompt: image.prompt,
              generationTime: image.createdAt,
              dimensions: image.dimensions || null,
              cost: image.cost || 0,
              ...image.metadata
            },
            status: 'active'
          }
        ])
        .select('*')
        .single();

      if (error) {
        console.error('Error saving image:', error);
        continue; // Continue saving other images even if one fails
      }

      savedImages.push(data);
    }

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({
        success: true,
        data: savedImages,
        count: savedImages.length
      }) 
    };

  } catch (error) {
    console.error('Save generated images error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ 
      error: error.message 
    }) };
  }
};
