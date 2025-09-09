// Create actual Printify products with AI-generated designs
// This function creates real products in the user's Printify shop

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

export default async (req, context) => {
  console.log('=== CREATE PRINTIFY PRODUCT FUNCTION START ===');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed' }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    const { shopId, blueprintId, title, description, images, printAreas, style, audience, providerId } = await req.json();
    
    if (!shopId || !blueprintId || !images || images.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing required parameters' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'Authorization header required' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Get API key from user's stored credentials
    const apiKeyResponse = await fetch(`${new URL(req.url).origin}/.netlify/functions/get-api-key`, {
      headers: { Authorization: authHeader }
    });
    
    if (!apiKeyResponse.ok) {
      throw new Error('Failed to get API key');
    }
    
    const { apiKey } = await apiKeyResponse.json();
    if (!apiKey) {
      throw new Error('No API key found');
    }

    // First, upload the design images to Printify
    const uploadedImages = [];
    
    for (const image of images) {
      try {
        const uploadResponse = await fetch('https://api.printify.com/v1/uploads/images.json', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            file_name: `design_${Date.now()}.png`,
            url: image.url
          })
        });

        if (uploadResponse.ok) {
          const uploadData = await uploadResponse.json();
          uploadedImages.push({
            id: uploadData.id,
            position: image.position,
            width: image.width,
            height: image.height
          });
          console.log('Uploaded image:', uploadData.id);
        } else {
          console.error('Failed to upload image:', await uploadResponse.text());
        }
      } catch (error) {
        console.error('Error uploading image:', error);
      }
    }

    if (uploadedImages.length === 0) {
      throw new Error('Failed to upload any images');
    }

    // First, get blueprint details to find valid variants and print providers
    const blueprintResponse = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}.json`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!blueprintResponse.ok) {
      throw new Error(`Blueprint not found: ${blueprintId}`);
    }

    const blueprint = await blueprintResponse.json();
    console.log('Blueprint details:', blueprint.title);

    // Use the provided provider ID or fall back to first available
    let printProvider;
    if (providerId) {
      console.log(`Looking for provider ID ${providerId} in blueprint ${blueprintId}`);
      console.log('Available print providers:', JSON.stringify(blueprint.print_providers.map(p => ({ id: p.id, title: p.title }))));
      
      printProvider = blueprint.print_providers?.find(p => p.id === parseInt(providerId));
      
      // If the provided ID isn't found, fall back to the first available provider
      if (!printProvider) {
        console.log(`Provider ID ${providerId} not found for blueprint ${blueprintId}, falling back to first available provider`);
        printProvider = blueprint.print_providers?.[0];
        if (!printProvider) {
          throw new Error('No print providers available for this blueprint');
        }
        console.log(`Using fallback provider ID: ${printProvider.id}`);
      }
    } else {
      printProvider = blueprint.print_providers?.[0];
      if (!printProvider) {
        throw new Error('No print providers available for this blueprint');
      }
      console.log(`No provider ID specified, using default provider ID: ${printProvider.id}`);
    }

    // Get the first available variant
    const variant = printProvider.variants?.[0];
    if (!variant) {
      throw new Error('No variants available for this blueprint');
    }

    // Create the product with uploaded designs
    const productData = {
      title: title || 'Custom Design Product',
      description: description || 'Custom designed product with AI-generated artwork',
      blueprint_id: parseInt(blueprintId),
      print_provider_id: printProvider.id,
      variants: [
        {
          id: variant.id,
          price: 2000, // $20.00 in cents
          is_enabled: true
        }
      ],
      print_areas: printAreas?.map(area => ({
        variant_ids: [variant.id],
        placeholders: [{
          position: area.position,
          images: uploadedImages
            .filter(img => img.position === area.position)
            .map(img => ({
              id: img.id,
              x: 0.5,
              y: 0.5,
              scale: 1,
              angle: 0
            }))
        }]
      })) || []
    };

    console.log('Creating product with data:', JSON.stringify(productData, null, 2));

    const createResponse = await fetch(`https://api.printify.com/v1/shops/${shopId}/products.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(productData)
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error('Printify API error:', errorText);
      throw new Error(`Printify API error: ${createResponse.status} - ${errorText}`);
    }

    const createdProduct = await createResponse.json();
    console.log('Created product:', createdProduct.id);

    return new Response(
      JSON.stringify({
        success: true,
        product: createdProduct,
        uploaded_images: uploadedImages
      }),
      { headers: corsHeaders }
    );

  } catch (error) {
    console.error('Error creating Printify product:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Failed to create product' 
      }),
      { status: 500, headers: corsHeaders }
    );
  }
};
