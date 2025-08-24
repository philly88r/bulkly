// Save AI prompts and product data to Neon database
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

const DATABASE_URL = Deno.env.get('NETLIFY_DATABASE_URL') || Deno.env.get('DATABASE_URL');

export default async (req, context) => {
  // Enable CORS
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
    const client = new Client(DATABASE_URL);
    await client.connect();

    const { productId, prompt, response, metadata, brand } = await req.json();

    // Create prompts table if it doesn't exist
    await client.queryObject(`
      CREATE TABLE IF NOT EXISTS prompts (
        id SERIAL PRIMARY KEY,
        product_id VARCHAR(255),
        prompt TEXT NOT NULL,
        response JSONB,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insert the prompt and response
    const result = await client.queryObject(`
      INSERT INTO prompts (product_id, prompt, response, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [productId, prompt, JSON.stringify(response), JSON.stringify(metadata)]);

    await client.end();

    return new Response(JSON.stringify({
      success: true,
      data: result.rows[0]
    }), { headers });

  } catch (error) {
    console.error('Save prompt error:', error);
    return new Response(JSON.stringify({ 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
