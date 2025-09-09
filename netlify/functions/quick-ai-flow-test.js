// Quick AI Process Flow Tester - Tests the actual workflow, not just APIs
const { createClient } = require('./_db');
const fetch = require('node-fetch');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function requireAuth(event){
  const auth = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (!auth) throw new Error('Unauthorized');
  return auth;
}

function getOrigin(event){
  try {
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    return `${proto}://${host}`;
  } catch { return 'https://localhost:8888'; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  
  const results = {
    timestamp: new Date().toISOString(),
    steps: {},
    overall: 'UNKNOWN'
  };

  try {
    // Get auth header if available
    let authHeader = null;
    try {
      authHeader = requireAuth(event);
      results.steps.auth = { status: 'OK', message: 'Authorization header found' };
    } catch (e) {
      results.steps.auth = { status: 'WARNING', message: 'No auth header - some tests will be skipped' };
    }

    const origin = getOrigin(event);

    // Step 1: Test parse-user-intent
    console.log('[FLOW-TEST] Testing parse-user-intent...');
    try {
      const parseRes = await fetch(`${origin}/.netlify/functions/parse-user-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'create 3 dog t-shirts',
          currentState: { prompt: '', quantity: null, productScope: null }
        })
      });
      
      const parseText = await parseRes.text();
      let parseData;
      try {
        parseData = JSON.parse(parseText);
      } catch {
        throw new Error(`Non-JSON response: ${parseText.slice(0, 200)}`);
      }
      
      if (parseData.success && parseData.updatedState) {
        results.steps.parse_intent = { 
          status: 'OK', 
          message: `Parsed successfully. Quantity: ${parseData.updatedState.quantity}`,
          data: parseData.updatedState
        };
      } else {
        throw new Error(`Parse failed: ${parseData.error || 'Unknown error'}`);
      }
    } catch (e) {
      results.steps.parse_intent = { status: 'FAILED', error: e.message };
    }

    // Step 2: Test generate-content with parsed details
    console.log('[FLOW-TEST] Testing generate-content...');
    try {
      const contentRes = await fetch(`${origin}/.netlify/functions/generate-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'cartoon style dog t-shirt design with bright colors for dog lovers',
          contentType: 'product-content',
          style: 'cartoon',
          colors: 'bright vibrant colors',
          audience: 'dog lovers and pet owners',
          productInfo: [{
            title: 'Unisex Jersey Short Sleeve Tee',
            brand: 'Bella + Canvas',
            category: 'apparel'
          }]
        })
      });
      
      const contentText = await contentRes.text();
      let contentData;
      try {
        contentData = JSON.parse(contentText);
      } catch {
        throw new Error(`Non-JSON response: ${contentText.slice(0, 200)}`);
      }
      
      if (contentData.success && contentData.title && contentData.description) {
        results.steps.generate_content = { 
          status: 'OK', 
          message: `Generated title: "${contentData.title.slice(0, 50)}...", desc: ${contentData.description.length} chars, tags: ${Array.isArray(contentData.tags) ? contentData.tags.length : 'none'}`,
          data: {
            title: contentData.title,
            description: contentData.description.slice(0, 100) + '...',
            tagsCount: Array.isArray(contentData.tags) ? contentData.tags.length : 0,
            featuresCount: Array.isArray(contentData.key_features) ? contentData.key_features.length : 0,
            materialsCount: Array.isArray(contentData.materials) ? contentData.materials.length : 0
          }
        };
      } else {
        throw new Error(`Content generation failed: ${contentData.error || 'Missing title/description'} | Response: ${JSON.stringify(contentData).slice(0, 200)}`);
      }
    } catch (e) {
      results.steps.generate_content = { status: 'FAILED', error: e.message };
    }

    // Step 3: Test job creation (only if we have auth)
    if (authHeader) {
      console.log('[FLOW-TEST] Testing quick-job-create...');
      try {
        const jobRes = await fetch(`${origin}/.netlify/functions/quick-job-create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({
            prompt: 'test dog t-shirts',
            quantity: 1,
            productScope: 'tshirt',
            imageMode: 'generate',
            shopId: 'test-shop-123',
            style: 'cartoon'
          })
        });
        
        const jobText = await jobRes.text();
        let jobData;
        try {
          jobData = JSON.parse(jobText);
        } catch {
          throw new Error(`Non-JSON response: ${jobText.slice(0, 200)}`);
        }
        
        if (jobData.success && jobData.job_id) {
          results.steps.job_create = { 
            status: 'OK', 
            message: `Job created: ${jobData.job_id}`,
            jobId: jobData.job_id
          };

          // Step 4: Test job status retrieval
          console.log('[FLOW-TEST] Testing job status...');
          try {
            const statusRes = await fetch(`${origin}/.netlify/functions/quick-job-get-status`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: authHeader },
              body: JSON.stringify({ job_id: jobData.job_id })
            });
            
            const statusText = await statusRes.text();
            let statusData;
            try {
              statusData = JSON.parse(statusText);
            } catch {
              throw new Error(`Non-JSON response: ${statusText.slice(0, 200)}`);
            }
            
            if (statusData.success && statusData.job) {
              results.steps.job_status = { 
                status: 'OK', 
                message: `Status: ${statusData.job.status}, Total: ${statusData.job.total}`,
                jobStatus: statusData.job.status
              };
            } else {
              throw new Error(`Status failed: ${statusData.error || 'Unknown error'}`);
            }
          } catch (e) {
            results.steps.job_status = { status: 'FAILED', error: e.message };
          }

        } else {
          throw new Error(`Job creation failed: ${jobData.error || 'Unknown error'}`);
        }
      } catch (e) {
        results.steps.job_create = { status: 'FAILED', error: e.message };
      }
    } else {
      results.steps.job_create = { status: 'SKIPPED', message: 'No auth header provided' };
      results.steps.job_status = { status: 'SKIPPED', message: 'No auth header provided' };
    }

    // Step 5: Check background function exists
    console.log('[FLOW-TEST] Testing background function availability...');
    try {
      const bgRes = await fetch(`${origin}/.netlify/functions/job-runner-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: 'test-ping' })
      });
      
      if (bgRes.status === 401) {
        results.steps.background_function = { 
          status: 'OK', 
          message: 'Function exists (returned 401 Unauthorized as expected)'
        };
      } else if (bgRes.status === 202) {
        results.steps.background_function = { 
          status: 'OK', 
          message: 'Function exists and accepted request'
        };
      } else {
        results.steps.background_function = { 
          status: 'WARNING', 
          message: `Function returned unexpected status: ${bgRes.status}`
        };
      }
    } catch (e) {
      results.steps.background_function = { status: 'FAILED', error: e.message };
    }

    // Determine overall status
    const stepResults = Object.values(results.steps);
    const failed = stepResults.filter(s => s.status === 'FAILED');
    const warnings = stepResults.filter(s => s.status === 'WARNING');
    
    if (failed.length === 0) {
      results.overall = warnings.length === 0 ? 'ALL_WORKING' : 'MOSTLY_WORKING';
    } else {
      results.overall = 'BROKEN';
      results.failedSteps = failed.map(s => s.error || 'Unknown error');
    }

  } catch (e) {
    results.error = e.message;
    results.overall = 'ERROR';
  }

  console.log('[FLOW-TEST] Complete:', results.overall);
  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify(results, null, 2)
  };
};
