// Database setup script for Netlify-Neon integration
import { Client } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

const DATABASE_URL = Deno.env.get('NETLIFY_DATABASE_URL') || Deno.env.get('DATABASE_URL');

export default async (req, context) => {
  try {
    const client = new Client(DATABASE_URL);
    await client.connect();
    
    // Create products table for POD management
    await client.queryObject(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2),
        image_url TEXT,
        blueprint_id VARCHAR(100),
        tags TEXT[],
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create orders table
    await client.queryObject(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        customer_email VARCHAR(255),
        order_status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Insert sample data
    const sampleProducts = [
      {
        title: 'Custom T-Shirt',
        description: 'Personalized t-shirt with custom design',
        price: 24.99,
        image_url: 'https://example.com/sample.jpg',
        blueprint_id: 't-shirt-001',
        tags: ['t-shirt', 'custom', 'personalized']
      }
    ];
    
    for (const product of sampleProducts) {
      await client.queryObject(`
        INSERT INTO products (title, description, price, image_url, blueprint_id, tags)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [product.title, product.description, product.price, product.image_url, product.blueprint_id, product.tags]);
    }
    
    const result = await client.queryObject('SELECT * FROM products ORDER BY created_at DESC LIMIT 10');
    
    await client.end();
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Database setup complete',
      products: result.rows
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Database setup error:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      database: 'little-pine-91318701'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
