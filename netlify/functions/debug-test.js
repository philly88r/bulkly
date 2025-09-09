// Ultra-simple diagnostic that can't fail
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  
  console.log('[DEBUG-TEST] Starting ultra simple test');
  
  let result = {
    step: 'starting',
    status: 'unknown',
    error: null,
    data: {}
  };

  try {
    result.step = 'environment_check';
    result.data.env = {
      hasGemini: !!process.env.GEMINI_API_KEY,
      hasDB: !!(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL),
      hasFAL: !!process.env.FAL_KEY
    };
    console.log('[DEBUG-TEST] Environment check done');

    result.step = 'testing_parse_intent';
    const fetch = require('node-fetch');
    const origin = `https://${event.headers.host}`;
    
    console.log('[DEBUG-TEST] About to test parse-user-intent');
    const parseResponse = await fetch(`${origin}/.netlify/functions/parse-user-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'create 3 dog shirts',
        currentState: { prompt: '', quantity: null }
      })
    });
    
    console.log('[DEBUG-TEST] Parse response status:', parseResponse.status);
    const parseText = await parseResponse.text();
    console.log('[DEBUG-TEST] Parse response text length:', parseText.length);
    
    result.data.parseTest = {
      status: parseResponse.status,
      responseLength: parseText.length,
      response: parseText.substring(0, 200)
    };

    if (parseResponse.status === 200) {
      try {
        const parseData = JSON.parse(parseText);
        result.data.parseTest.success = parseData.success;
        result.data.parseTest.hasUpdatedState = !!parseData.updatedState;
      } catch (e) {
        result.data.parseTest.parseError = e.message;
      }
    }

    result.step = 'complete';
    result.status = 'success';
    
  } catch (error) {
    console.error('[DEBUG-TEST] Error at step:', result.step, error);
    result.error = error.message;
    result.status = 'failed';
  }

  console.log('[DEBUG-TEST] Final result:', JSON.stringify(result, null, 2));

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify(result, null, 2)
  };
};
