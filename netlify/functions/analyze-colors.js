// Analyze image colors and suggest variant colors
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

const DATABASE_URL = Deno.env.get('NETLIFY_DATABASE_URL') || Deno.env.get('DATABASE_URL');

export default async (req, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    const { imageUrl, productType, baseColors } = await req.json();

    // Create color analysis table
    const client = new Client(DATABASE_URL);
    await client.connect();

    await client.queryObject(`
      CREATE TABLE IF NOT EXISTS color_analysis (
        id SERIAL PRIMARY KEY,
        image_url TEXT NOT NULL,
        dominant_colors JSONB,
        suggested_variants JSONB,
        product_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // AI color analysis prompt
    const colorPrompt = `Analyze this ${productType} image and suggest 5-7 variant colors that would complement the dominant colors.
    
Image URL: ${imageUrl}
Base Colors: ${JSON.stringify(baseColors)}

Requirements:
- Suggest colors that harmonize with the image's color palette
- Consider color theory (complementary, analogous, triadic)
- Ensure colors work well for ${productType}
- Provide hex codes and color names
- Explain why each color works with the image

Format as JSON:
{
  "dominant_colors": ["#hex1", "#hex2"],
  "suggested_variants": [
    {
      "color": "#hex",
      "name": "Color Name",
      "reasoning": "Why this color works",
      "confidence": 0.95
    }
  ]
}`;

    // For now, return sample analysis (replace with actual AI call)
    const suggestedVariants = [
      {
        color: "#2E8B57",
        name: "Sea Green",
        reasoning: "Complements warm tones in the image",
        confidence: 0.92
      },
      {
        color: "#DDA0DD",
        name: "Plum",
        reasoning: "Provides elegant contrast",
        confidence: 0.88
      },
      {
        color: "#F4A460",
        name: "Sandy Brown",
        reasoning: "Harmonizes with existing warm palette",
        confidence: 0.85
      }
    ];

    // Save analysis to database
    const result = await client.queryObject(`
      INSERT INTO color_analysis (image_url, dominant_colors, suggested_variants, product_type)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [imageUrl, JSON.stringify(baseColors), JSON.stringify(suggestedVariants), productType]);

    await client.end();

    return new Response(JSON.stringify({
      success: true,
      analysis: result.rows[0],
      suggestedVariants
    }), { headers });

  } catch (error) {
    console.error('Color analysis error:', error);
    return new Response(JSON.stringify({ 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
