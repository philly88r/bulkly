// /.netlify/functions/plan-next-question.js
// Generates the next conversational question based on current chat state using Gemini.

const fetch = require('node-fetch');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };

  try {
    const { chatState = {}, history = [], requiredMissing = [], niceMissing = [], known = [] } = JSON.parse(event.body || '{}');
    // Clean the API key (remove any whitespace)
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: 'Missing GEMINI_API_KEY' }) };
    }

    // Build a compact, domain-aware system prompt (Printify bulk product creation)
    const system = `You are an assistant that helps create Printify products via a short chat.
Behavior:
- Ask ONE concise question at a time (<= 20 words), friendly, specific, context-aware.
- FIRST resolve required fields in this order: store, quantity, product scope, image mode, image URLs (if upload).
- THEN resolve optional improvements: style, background, consistency, colors, audience, tone, tags, language, provider/brand, print areas, variants, publish mode, markup, collections, DPI, retries, pause-after.
- Use what is already known to avoid repeats. Never say generic lines like "Could you share more details?".
- If user says change/set, accept it and move forward.
- If all required are known, briefly confirm the plan and ask for "yes" to start.
Context known: ${known.join(', ') || 'none'}
Missing required: ${requiredMissing.join(', ') || 'none'}
Missing optional: ${niceMissing.join(', ') || 'none'}`;

    const user = `State JSON: ${JSON.stringify(chatState)}`;
    const hist = history.slice(-6).map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 500) }] }));

    const body = {
      contents: [
        { role: 'user', parts: [{ text: system }] },
        ...hist,
        { role: 'user', parts: [{ text: user }] },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 80 },
    };

    // Try multiple models in case one doesn't work
    const models = [
      'gemini-2.5-flash',
      'gemini-pro',
      'gemini-1.0-pro'
    ];
    
    let data = null;
    let lastError = null;
    
    for (const model of models) {
      try {
        console.log(`Trying model: ${model}`);
        const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify(body) 
        });
        
        if (!res.ok) {
          const txt = await res.text();
          console.log(`Error with ${model}: ${txt}`);
          lastError = txt;
          continue; // Try next model
        }
        
        data = await res.json();
        console.log(`Success with ${model}`);
        break; // Success, exit loop
      } catch (err) {
        console.log(`Exception with ${model}: ${err.message}`);
        lastError = err.message;
      }
    }
    
    if (!data) {
      return { 
        statusCode: 502, 
        headers: cors, 
        body: JSON.stringify({ 
          success: false, 
          error: 'All Gemini models failed', 
          details: lastError 
        }) 
      };
    }
    
    // Extract the question from the Gemini API response.
    const question = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

    // If the API returned an empty or invalid response, log it and return a clear error.
    if (!question) {
      console.log('plan-next-question: Gemini API returned an empty or invalid response. Full payload:', JSON.stringify(data, null, 2));
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          success: false,
          error: 'The AI assistant failed to generate a response. Please check the function logs for details.'
        })
      };
    }

    // Return the valid question from the API.
    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, question }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
