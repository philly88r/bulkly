// Netlify Edge Function for Neon database connection
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

const DATABASE_URL = Deno.env.get('NETLIFY_DATABASE_URL') || Deno.env.get('DATABASE_URL');

const client = new Client(DATABASE_URL);

export default async (req, context) => {
  try {
    await client.connect();
    
    // Example query - adjust based on your needs
    const result = await client.queryObject(`
      SELECT * FROM products LIMIT 10
    `);
    
    await client.end();
    
    return new Response(JSON.stringify(result.rows), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Database error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
