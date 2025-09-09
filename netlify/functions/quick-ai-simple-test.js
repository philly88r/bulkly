// Simple Quick AI Diagnostic - No complex logic that can fail
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
    environment: {},
    status: 'unknown'
  };

  try {
    // Check environment variables
    results.environment = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET' : 'MISSING',
      FAL_KEY: process.env.FAL_KEY ? 'SET' : 'MISSING',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'MISSING',
      SUPABASE_DB_URL: process.env.SUPABASE_DB_URL ? 'SET' : 'MISSING',
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'MISSING'
    };

    // Simple database test
    try {
      const { createClient } = require('./_db');
      const client = createClient();
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      results.database = 'CONNECTED';
    } catch (e) {
      results.database = 'FAILED: ' + e.message.substring(0, 100);
    }

    // Simple Gemini test
    if (process.env.GEMINI_API_KEY) {
      try {
        const fetch = require('node-fetch');
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'test' }] }]
          })
        });
        results.gemini = response.ok ? 'WORKING' : 'FAILED: HTTP ' + response.status;
      } catch (e) {
        results.gemini = 'FAILED: ' + e.message.substring(0, 50);
      }
    } else {
      results.gemini = 'NO_API_KEY';
    }

    // Determine overall status
    const hasGemini = results.gemini === 'WORKING';
    const hasDB = results.database === 'CONNECTED';
    const hasFAL = results.environment.FAL_KEY === 'SET';
    
    if (hasGemini && hasDB && hasFAL) {
      results.status = 'READY';
    } else {
      results.status = 'NEEDS_SETUP';
      results.missing = [];
      if (!hasGemini) results.missing.push('Gemini API');
      if (!hasDB) results.missing.push('Database');
      if (!hasFAL) results.missing.push('FAL API Key');
    }

  } catch (e) {
    results.error = e.message;
    results.status = 'ERROR';
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify(results, null, 2)
  };
};
