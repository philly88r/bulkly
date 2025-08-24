// AI Content Generation for Printify Product Details
// Handles title, description, and tags generation using Google Gemini API

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyC938XfkIJF9ujbu-453G6Z2KjUMaBMyso';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

export default async (req, context) => {
  console.log('=== GENERATE CONTENT FUNCTION START ===');
  console.log('Method:', req.method);
  console.log('Headers:', req.headers);
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    console.log('CORS preflight request handled');
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    console.log('Invalid method:', req.method);
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed' }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    console.log('Parsing request body...');
    const requestBody = await req.text();
    console.log('Raw request body:', requestBody);
    
    const { prompt, contentType } = JSON.parse(requestBody);
    console.log('Parsed data - prompt:', prompt);
    console.log('Parsed data - contentType:', contentType);
    
    if (!prompt || !contentType) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing prompt or contentType' }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!GEMINI_API_KEY) {
      console.log('ERROR: Gemini API key not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Gemini API key not configured' }),
        { status: 500, headers: corsHeaders }
      );
    }

    console.log('Gemini API key found, length:', GEMINI_API_KEY.length);

    let systemPrompt = '';
    let maxTokens = 150;

    switch (contentType) {
      case 'title':
        systemPrompt = `You are an expert e-commerce copywriter. Generate a compelling, SEO-optimized product title (max 100 characters) based on the provided product details. Make it engaging and include key selling points.`;
        maxTokens = 50;
        break;
      case 'description':
        systemPrompt = `You are an expert e-commerce copywriter. Write a compelling product description (2-3 paragraphs) that highlights benefits, appeals to the target audience, and includes relevant keywords. Make it persuasive but authentic.`;
        maxTokens = 200;
        break;
      case 'tags':
        systemPrompt = `Generate 5-8 relevant product tags/keywords for e-commerce SEO. Return only comma-separated values, no additional text. Focus on searchable terms that buyers would use.`;
        maxTokens = 100;
        break;
      case 'product-content':
        systemPrompt = `You are an expert e-commerce copywriter. Based on the user request, generate a JSON object with three keys: "title" (a compelling, SEO-optimized product title, max 100 chars), "description" (a persuasive 2-3 paragraph product description), and "tags" (an array of 5-8 relevant string keywords). Do not include any text outside of the JSON object.`;
        maxTokens = 500;
        break;
      default:
        console.log('ERROR: Invalid contentType:', contentType);
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid contentType' }),
          { status: 400, headers: corsHeaders }
        );
    }

    console.log('System prompt set for contentType:', contentType);
    console.log('Max tokens:', maxTokens);

    console.log('Making Gemini API request...');
    
    // Combine system prompt and user prompt for Gemini
    const fullPrompt = `${systemPrompt}\n\nUser request: ${prompt}`;
    
    const geminiPayload = {
      contents: [
        {
          parts: [
            {
              text: fullPrompt
            }
          ]
        }
      ]
    };
    console.log('Gemini payload:', JSON.stringify(geminiPayload, null, 2));

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify(geminiPayload),
    });

    console.log('Gemini response status:', response.status);
    console.log('Gemini response headers:', response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('Gemini error response:', errorText);
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Gemini response data:', JSON.stringify(data, null, 2));
    
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    console.log('Generated content:', content);

    if (!content) {
      console.log('ERROR: No content generated from Gemini');
      throw new Error('No content generated');
    }

    // Clean up tags format if needed
    let responseData;

    if (contentType === 'product-content') {
      console.log('Parsing product content JSON...');
      try {
        // Clean the string to remove markdown code fences
        const jsonString = content.replace(/```json\n|```/g, '').trim();
        const parsedContent = JSON.parse(jsonString);
        responseData = { success: true, ...parsedContent };
      } catch (e) {
        console.error('Failed to parse JSON from AI response:', e);
        throw new Error('AI returned invalid JSON format.');
      }
    } else if (contentType === 'tags') {
      console.log('Processing tags format...');
      const finalContent = content.split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);
      responseData = { success: true, content: finalContent };
    } else {
        responseData = { success: true, content };
    }

    responseData.tokens = data.usageMetadata?.totalTokenCount || 0;
    console.log('Returning success response:', JSON.stringify(responseData, null, 2));

    return new Response(
      JSON.stringify(responseData),
      { headers: corsHeaders }
    );

  } catch (error) {
    console.error('=== AI CONTENT GENERATION ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Full error object:', error);
    
    const errorResponse = { 
      success: false, 
      error: error.message || 'Failed to generate content' 
    };
    console.log('Returning error response:', JSON.stringify(errorResponse, null, 2));
    
    return new Response(
      JSON.stringify(errorResponse),
      { status: 500, headers: corsHeaders }
    );
  }
};
