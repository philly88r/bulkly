// Retrieve AI prompts and product data from Neon database
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

const DATABASE_URL = Deno.env.get('NETLIFY_DATABASE_URL') || Deno.env.get('DATABASE_URL');

export default async (req, context) => {
  // Enable CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    const client = new Client(DATABASE_URL);
    await client.connect();

    const url = new URL(req.url);
    const productId = url.searchParams.get('productId');

    let query = 'SELECT * FROM prompts ORDER BY created_at DESC';
    let params = [];

    if (productId) {
      query = 'SELECT * FROM prompts WHERE product_id = $1 ORDER BY created_at DESC';
      params = [productId];
    }

    const result = await client.queryObject(query, params);
    await client.end();

    return new Response(JSON.stringify({
      success: true,
      data: result.rows,
      count: result.rows.length
    }), { headers });

  } catch (error) {
    console.error('Get prompt error:', error);
    return new Response(JSON.stringify({ 
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
