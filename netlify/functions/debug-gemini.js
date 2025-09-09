// /.netlify/functions/debug-gemini.js
// Simple test for Gemini API connectivity

const fetch = require('node-fetch');

exports.handler = async () => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    // Get the API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { 
        statusCode: 200, 
        headers: cors, 
        body: JSON.stringify({ 
          success: false, 
          error: 'Missing GEMINI_API_KEY',
          env_vars: Object.keys(process.env).filter(k => !k.toLowerCase().includes('key') && !k.toLowerCase().includes('secret') && !k.toLowerCase().includes('password')).join(', ')
        })
      };
    }

    // Simple test prompt
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Say hello in one word' }] }
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 10 }
    };

    // Try the API call
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify(body) 
    });
    
    const responseText = await res.text();
    let responseData;
    
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      responseData = null;
    }

    return { 
      statusCode: 200, 
      headers: cors, 
      body: JSON.stringify({
        success: res.ok,
        status: res.status,
        api_key_length: apiKey.length,
        api_key_prefix: apiKey.substring(0, 5) + '...',
        response: responseData || responseText,
        model: 'gemini-2.5-flash'
      })
    };
  } catch (err) {
    return { 
      statusCode: 200, 
      headers: cors, 
      body: JSON.stringify({ 
        success: false, 
        error: err.message,
        stack: err.stack
      })
    };
  }
};
