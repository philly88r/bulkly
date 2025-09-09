// /.netlify/functions/parse-user-intent.js
// Uses Gemini to parse natural language user input into a structured chatState object.

const fetch = require('node-fetch');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// The schema of the state object we want the AI to fill.
const STATE_SCHEMA = {
  prompt: 'string (the core user request, e.g., "retro dog t-shirts")',
  quantity: 'number (e.g., 10)',
  productScope: 'string (enum: any, tshirt, hoodies, mugs, posters)',
  imageMode: 'string (enum: generate, upload)',
  style: 'string (e.g., watercolor, vintage, retro, modern, minimal, cartoon, line art)',
  publishMode: 'string (enum: draft, publish)',
  markup: 'number (percentage, e.g., 40)',
  background: 'string (enum: transparent, white, contextual)',
  consistency: 'string (enum: consistent, diverse)',
  colors: 'string (e.g., pastel, neon, monochrome)',
  audience: 'string (e.g., men, women, kids, pet lovers)',
  tone: 'string (e.g., friendly, premium, playful, modern)',
  tags: 'string (comma-separated list of keywords)',
  // ... other fields can be added here
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };

  try {
    const { text, currentState } = JSON.parse(event.body || '{}');
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: 'Missing GEMINI_API_KEY' }) };
    }

    // 0) Local heuristics: handle short single-slot answers without calling AI
    try {
      const t = String(text || '').trim();
      if (t) {
        const s = typeof currentState === 'object' && currentState ? { ...currentState } : {};
        const lower = t.toLowerCase();
        // Audience detector
        if (/(audience|who is the target|target audience|demographic)/i.test(s._lastQuestion || '') || /fans|adults|kids|men|women|audience/.test(lower)) {
          s.audience = t;
          return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) };
        }
        // Simple fields by keyword
        if (/draft|publish/i.test(lower)) { s.publishMode = /publish/i.test(lower) ? 'publish' : 'draft'; return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) }; }
        if (/transparent|white|contextual/i.test(lower)) { s.background = /transparent/i.test(lower) ? 'transparent' : /white/i.test(lower) ? 'white' : 'contextual'; return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) }; }
        if (/generate|upload/i.test(lower)) { s.imageMode = /upload/i.test(lower) ? 'upload' : 'generate'; return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) }; }
        if (/t\s*-?shirt|hoodie|mug|poster|bottle|towel|phone\s*case|cards?|backpack/i.test(lower)) { s.productScope = lower; return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) }; }
        if (/^\d+$/i.test(lower)) { s.quantity = Number(lower); return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) }; }
        // If very short answer (< 40 chars), assume it's a tag-like or audience/brand input; store into tags if empty
        if (t.length < 40 && !s.audience) { s.audience = t; return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: s }) }; }
      }
    } catch (_) {}

    const systemPrompt = `You are an NLU (Natural Language Understanding) engine. Your task is to parse the user's text and update the provided JSON state object. 

1.  Analyze the user's text to extract any relevant information.
2.  Update the fields in the 'currentState' JSON object with the extracted information. 
3.  Do NOT add any new keys to the object. Only update existing ones.
4.  If a value is not mentioned in the user's text, keep the existing value from 'currentState'.
5.  Your response MUST be only the updated JSON object, with no other text, comments, or markdown.

Here is the schema for the state object: ${JSON.stringify(STATE_SCHEMA, null, 2)}`;

    const body = {
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'Understood. I will return only the updated JSON object.' }] },
        { role: 'user', parts: [{ text: `User Text: "${text}"\n\nCurrent State: ${JSON.stringify(currentState)}` }] },
      ],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    };
    // 1) Multi-model fallback for robustness
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
    let data = null, lastErr = null;
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { lastErr = new Error(await res.text()); continue; }
        const json = await res.json();
        const part = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (part) { data = part; break; }
        lastErr = new Error('No candidates');
      } catch (e) { lastErr = e; }
    }
    if (!data) {
      // As a safe minimal fallback, return currentState unchanged
      console.warn('parse-user-intent: all models failed, returning currentState');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: currentState||{} }) };
    }

    // 2) Safe JSON repair for minor formatting issues
    let updatedState;
    try {
      updatedState = JSON.parse(data);
    } catch (e) {
      try {
        let repaired = String(data)
          .replace(/^```(?:json)?/i, '').replace(/```$/i, '')
          .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
          .trim();
        if (!/^{[\s\S]*}$/.test(repaired)) {
          const m = repaired.match(/\{[\s\S]*\}/); if (m) repaired = m[0];
        }
        updatedState = JSON.parse(repaired);
      } catch (e2) {
        console.warn('parse-user-intent: JSON repair failed, returning currentState');
        return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState: currentState||{} }) };
      }
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updatedState }) };
  } catch (err) {
    console.error('parse-user-intent error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
