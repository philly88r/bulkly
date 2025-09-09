// MINIMAL workflow test - will work or tell us exactly why not
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  console.log('=== WORKFLOW TEST START ===');
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  let step = 'INIT';
  
  try {
    step = 'BASIC_SETUP';
    console.log('Step:', step);
    
    const result = {
      step1_parse: 'NOT_STARTED',
      step2_content: 'NOT_STARTED', 
      step3_image: 'NOT_STARTED',
      step4_job: 'NOT_STARTED',
      currentStep: step,
      timestamp: Date.now()
    };

    step = 'FETCH_SETUP';
    console.log('Step:', step);
    const fetch = require('node-fetch');
    const origin = `https://${event.headers.host}`;
    
    // ONLY TEST STEP 1 FOR NOW - once this works we'll add more
    // STEP 1: Parse Intent
    step = 'PARSE_INTENT';
    console.log('Step:', step);
    result.currentStep = step;
    
    const parseRes = await fetch(`${origin}/.netlify/functions/parse-user-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'create 2 dog shirts',
        currentState: { prompt: '', quantity: null }
      })
    });
    
    console.log('Parse status:', parseRes.status);
    
    if (parseRes.status === 200) {
      const parseData = await parseRes.json();
      if (parseData.success) {
        result.step1_parse = 'SUCCESS';
        console.log('Parse SUCCESS');
      } else {
        result.step1_parse = 'FAILED: ' + (parseData.error || 'Unknown');
        console.log('Parse FAILED:', parseData.error);
      }
    } else {
      result.step1_parse = 'HTTP_ERROR: ' + parseRes.status;
      console.log('Parse HTTP ERROR:', parseRes.status);
    }

    // TODO: Add other steps after this works
    // STEP 2: Generate Content
    step = 'GENERATE_CONTENT';
    console.log('Step:', step);
    result.currentStep = step;
    
    const contentRes = await fetch(`${origin}/.netlify/functions/generate-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'cartoon dog t-shirt design',
        contentType: 'product-content',
        style: 'cartoon',
        colors: 'bright',
        audience: 'dog lovers',
        productInfo: [{ title: 'T-Shirt', brand: 'Test' }]
      })
    });
    
    console.log('Content status:', contentRes.status);
    
    if (contentRes.status === 200) {
      const contentData = await contentRes.json();
      if (contentData.success && contentData.title) {
        result.step2_content = 'SUCCESS';
        console.log('Content SUCCESS');
      } else {
        result.step2_content = 'FAILED: ' + (contentData.error || 'No title');
        console.log('Content FAILED:', contentData.error);
      }
    } else {
      result.step2_content = 'HTTP_ERROR: ' + contentRes.status;
      console.log('Content HTTP ERROR:', contentRes.status);
    }
    
    result.step3_image = 'TODO: Add after step 2 works';
    result.step4_job = 'TODO: Add after step 2 works';

    // Return early result
    step = 'RETURN';
    console.log('Step:', step, 'Returning result');
    
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(result, null, 2)
    };

  } catch (error) {
    console.log('ERROR at step:', step, 'Error:', error.message);
    
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        error: error.message,
        failedAt: step,
        timestamp: Date.now()
      })
    };
  }
};
