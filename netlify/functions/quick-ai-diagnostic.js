// Quick AI System Diagnostic Test
const { createClient, getDatabaseUrl } = require('./_db');
const fetch = require('node-fetch');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  
  const results = {
    timestamp: new Date().toISOString(),
    tests: {}
  };

  // Test 1: Environment Variables
  console.log('[TEST] Checking environment variables...');
  results.tests.environment = {
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    FAL_KEY: !!process.env.FAL_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    SUPABASE_DB_URL: !!process.env.SUPABASE_DB_URL,
    DATABASE_URL: !!process.env.DATABASE_URL,
    NETLIFY_DATABASE_URL: !!process.env.NETLIFY_DATABASE_URL
  };

  // Test 2: Database Connection
  console.log('[TEST] Testing database connection...');
  try {
    getDatabaseUrl();
    const client = createClient();
    await client.connect();
    await client.query('SELECT 1 as test');
    await client.end();
    results.tests.database = { status: 'OK', message: 'Database connection successful' };
  } catch (e) {
    results.tests.database = { status: 'FAILED', error: e.message };
  }

  // Test 3: Gemini API
  console.log('[TEST] Testing Gemini API...');
  if (process.env.GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say "test successful"' }] }]
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        results.tests.gemini = { status: 'OK', response: text };
      } else {
        const error = await response.text();
        results.tests.gemini = { status: 'FAILED', error: `HTTP ${response.status}: ${error.slice(0, 200)}` };
      }
    } catch (e) {
      results.tests.gemini = { status: 'FAILED', error: e.message };
    }
  } else {
    results.tests.gemini = { status: 'SKIPPED', error: 'No GEMINI_API_KEY' };
  }

  // Test 4: FAL AI
  console.log('[TEST] Testing FAL AI...');
  if (process.env.FAL_KEY) {
    try {
      const response = await fetch('https://fal.run/fal-ai/fast-sdxl', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${process.env.FAL_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'test image',
          image_size: 'square_hd',
          num_inference_steps: 1,
          num_images: 1
        })
      });
      
      if (response.ok) {
        results.tests.fal = { status: 'OK', message: 'FAL API key valid' };
      } else {
        const error = await response.text();
        results.tests.fal = { status: 'FAILED', error: `HTTP ${response.status}: ${error.slice(0, 200)}` };
      }
    } catch (e) {
      results.tests.fal = { status: 'FAILED', error: e.message };
    }
  } else {
    results.tests.fal = { status: 'SKIPPED', error: 'No FAL_KEY' };
  }

  // Test 5: Quick Jobs Table
  console.log('[TEST] Testing quick_jobs table...');
  if (results.tests.database.status === 'OK') {
    try {
      const client = createClient();
      await client.connect();
      
      // Try to create table
      await client.query(`
        CREATE TABLE IF NOT EXISTS quick_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          created_by text,
          shop_id text NOT NULL,
          params jsonb NOT NULL,
          status text NOT NULL DEFAULT 'queued',
          total int NOT NULL DEFAULT 0,
          completed int NOT NULL DEFAULT 0,
          failed int NOT NULL DEFAULT 0,
          next_index int NOT NULL DEFAULT 0,
          results jsonb NOT NULL DEFAULT '[]'::jsonb
        );
      `);
      
      // Test insert/select
      const testResult = await client.query(
        'INSERT INTO quick_jobs (shop_id, params, total) VALUES ($1, $2, $3) RETURNING id',
        ['test-shop', '{"test": true}', 1]
      );
      
      const jobId = testResult.rows[0].id;
      
      // Clean up
      await client.query('DELETE FROM quick_jobs WHERE id = $1', [jobId]);
      await client.end();
      
      results.tests.quick_jobs_table = { status: 'OK', message: 'Table created and tested successfully' };
    } catch (e) {
      results.tests.quick_jobs_table = { status: 'FAILED', error: e.message };
    }
  } else {
    results.tests.quick_jobs_table = { status: 'SKIPPED', error: 'Database connection failed' };
  }

  // Overall status
  const allTests = Object.values(results.tests).filter(t => t && typeof t === 'object');
  const failedTests = allTests.filter(t => t.status === 'FAILED');
  const skippedTests = allTests.filter(t => t.status === 'SKIPPED');
  
  results.summary = {
    total: allTests.length,
    passed: allTests.filter(t => t.status === 'OK').length,
    failed: failedTests.length,
    skipped: skippedTests.length,
    overall: failedTests.length === 0 ? 'READY' : 'NEEDS_FIXES'
  };

  console.log('[TEST] Diagnostic complete:', results.summary);

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify(results, null, 2)
  };
};
