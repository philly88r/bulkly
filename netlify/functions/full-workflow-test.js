// Complete Quick AI Workflow Test - Every Single Step
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  console.log('[WORKFLOW-TEST] === FUNCTION START ===');
  console.log('[WORKFLOW-TEST] Method:', event.httpMethod);
  
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: cors, body: '' };
    }
    
    console.log('[WORKFLOW-TEST] Starting actual workflow test');
    
    let result = {
      steps: {},
      currentStep: 'starting',
      overallStatus: 'unknown',
      error: null,
      debug: {
        timestamp: new Date().toISOString(),
        method: event.httpMethod
      }
    };

    const fetch = require('node-fetch');
    const origin = `https://${event.headers.host}`;
    const authHeader = event.headers.authorization || event.headers.Authorization;
    
    console.log('[WORKFLOW-TEST] Environment - Origin:', origin, 'Auth:', !!authHeader);
    
    // STEP 1: Parse User Intent
    result.currentStep = 'parse_user_intent';
    console.log('[WORKFLOW-TEST] Step 1: Testing parse-user-intent');
    
    const parseResponse = await fetch(`${origin}/.netlify/functions/parse-user-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'create 3 cartoon dog t-shirts with bright colors',
        currentState: { 
          prompt: '', 
          quantity: null, 
          productScope: null
        }
      })
    });
    
    console.log('[WORKFLOW-TEST] Parse response status:', parseResponse.status);
    const parseText = await parseResponse.text();
    console.log('[WORKFLOW-TEST] Parse response length:', parseText.length);
    
    let parseData;
    try {
      parseData = JSON.parse(parseText);
    } catch (e) {
      throw new Error(`Parse Intent - Invalid JSON: ${parseText.substring(0, 200)}`);
    }
    
    if (!parseData.success || !parseData.updatedState) {
      throw new Error(`Parse Intent failed: ${parseData.error || 'No updated state'}`);
    }
    
    result.steps.parse_intent = {
      status: 'SUCCESS',
      data: {
        prompt: parseData.updatedState.prompt,
        quantity: parseData.updatedState.quantity,
        productScope: parseData.updatedState.productScope
      }
    };
    console.log('[WORKFLOW-TEST] Step 1 SUCCESS - Parsed quantity:', parseData.updatedState.quantity);

    // STEP 2: Generate Content
    result.currentStep = 'generate_content';
    console.log('[WORKFLOW-TEST] Step 2: Testing generate-content');
    
    const contentResponse = await fetch(`${origin}/.netlify/functions/generate-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'cartoon dog t-shirt design with bright colors for dog lovers',
        contentType: 'product-content',
        style: 'cartoon',
        colors: 'bright vibrant colors',
        audience: 'dog lovers and pet owners',
        productInfo: [{
          title: 'Unisex Jersey Short Sleeve Tee',
          brand: 'Bella + Canvas'
        }]
      })
    });
    
    console.log('[WORKFLOW-TEST] Content response status:', contentResponse.status);
    const contentText = await contentResponse.text();
    console.log('[WORKFLOW-TEST] Content response length:', contentText.length);
    
    let contentData;
    try {
      contentData = JSON.parse(contentText);
    } catch (e) {
      throw new Error(`Generate Content - Invalid JSON: ${contentText.substring(0, 200)}`);
    }
    
    if (!contentData.success || !contentData.title) {
      throw new Error(`Content generation failed: ${contentData.error || 'No title generated'}`);
    }
    
    result.steps.generate_content = {
      status: 'SUCCESS',
      data: {
        title: contentData.title,
        descriptionLength: contentData.description ? contentData.description.length : 0,
        tagsCount: Array.isArray(contentData.tags) ? contentData.tags.length : 0,
        featuresCount: Array.isArray(contentData.key_features) ? contentData.key_features.length : 0
      }
    };
    console.log('[WORKFLOW-TEST] Step 2 SUCCESS - Generated title:', contentData.title.substring(0, 50));

    // STEP 3: Generate Image
    result.currentStep = 'generate_image';
    console.log('[WORKFLOW-TEST] Step 3: Testing generate-image');
    
    const imageResponse = await fetch(`${origin}/.netlify/functions/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'cartoon style cute dog wearing t-shirt, bright colors, friendly expression',
        numImages: 1,
        model: 'flux-schnell',
        size: '1024x1024',
        style: 'cartoon',
        colors: 'bright',
        audience: 'dog lovers'
      })
    });
    
    console.log('[WORKFLOW-TEST] Image response status:', imageResponse.status);
    const imageText = await imageResponse.text();
    console.log('[WORKFLOW-TEST] Image response length:', imageText.length);
    
    let imageData;
    try {
      imageData = JSON.parse(imageText);
    } catch (e) {
      throw new Error(`Generate Image - Invalid JSON: ${imageText.substring(0, 200)}`);
    }
    
    if (!imageData.images || !Array.isArray(imageData.images) || imageData.images.length === 0) {
      throw new Error(`Image generation failed: ${imageData.error || 'No images returned'}`);
    }
    
    const imageUrl = imageData.images[0].url;
    result.steps.generate_image = {
      status: 'SUCCESS',
      data: {
        imageUrl: imageUrl,
        imageCount: imageData.images.length
      }
    };
    console.log('[WORKFLOW-TEST] Step 3 SUCCESS - Generated image URL');

    // STEP 4: Test Job Creation (if auth available)
    if (authHeader) {
      result.currentStep = 'create_job';
      console.log('[WORKFLOW-TEST] Step 4: Testing job creation');
      
      const jobResponse = await fetch(`${origin}/.netlify/functions/quick-job-create`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify({
          prompt: 'cartoon dog t-shirts with bright colors',
          quantity: 2,
          productScope: 'tshirt',
          imageMode: 'generate',
          shopId: 'test-shop-workflow',
          style: 'cartoon',
          colors: 'bright',
          audience: 'dog lovers'
        })
      });
      
      console.log('[WORKFLOW-TEST] Job response status:', jobResponse.status);
      const jobText = await jobResponse.text();
      console.log('[WORKFLOW-TEST] Job response length:', jobText.length);
      
      let jobData;
      try {
        jobData = JSON.parse(jobText);
      } catch (e) {
        throw new Error(`Create Job - Invalid JSON: ${jobText.substring(0, 200)}`);
      }
      
      if (!jobData.success || !jobData.job_id) {
        throw new Error(`Job creation failed: ${jobData.error || 'No job ID returned'}`);
      }
      
      result.steps.create_job = {
        status: 'SUCCESS',
        data: {
          jobId: jobData.job_id,
          status: jobData.status
        }
      };
      console.log('[WORKFLOW-TEST] Step 4 SUCCESS - Created job:', jobData.job_id);
    } else {
      result.steps.create_job = { status: 'SKIPPED', reason: 'No auth token' };
      console.log('[WORKFLOW-TEST] Step 4 SKIPPED - No auth token');
    }

    result.currentStep = 'complete';
    result.overallStatus = 'SUCCESS';
    console.log('[WORKFLOW-TEST] ALL STEPS COMPLETED SUCCESSFULLY');

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(result, null, 2)
    };

  } catch (error) {
    console.error(`[WORKFLOW-TEST] ERROR:`, error.message);
    
    const errorResult = {
      overallStatus: 'FAILED',
      currentStep: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    };
    
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(errorResult, null, 2)
    };
  } finally {
    console.log('[WORKFLOW-TEST] === FUNCTION END ===');
  }
};
