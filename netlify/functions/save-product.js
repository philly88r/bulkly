// Save complete product information including AI prompts to database
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

    const {
      title,
      description,
      price,
      tags,
      blueprint_id,
      image_url,
      ai_prompt,
      ai_response,
      metadata
    } = await req.json();

    // Create comprehensive products table
    await client.queryObject(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2),
        tags TEXT[],
        blueprint_id VARCHAR(100),
        image_url TEXT,
        ai_prompt TEXT,
        ai_response JSONB,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insert complete product with AI data
    const result = await client.queryObject(`
      INSERT INTO products (
        title, description, price, tags, blueprint_id, 
        image_url, ai_prompt, ai_response, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      title,
      description,
      price,
      tags,
      blueprint_id,
      image_url,
      ai_prompt,
      JSON.stringify(ai_response),
      JSON.stringify(metadata)
    ]);

    await client.end();

    return new Response(JSON.stringify({
      success: true,
      data: result.rows[0],
      message: 'Product saved with complete AI data'
    }), { headers });

  } catch (error) {
    console.error('Save product error:', error);
    return new Response(JSON.stringify({ 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
