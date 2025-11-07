// netlify/functions/poll-mockup-task.js
// Lightweight endpoint to fetch mockup task status and return URLs when ready
// Expects: POST { task_id:number }

const fetch = require('node-fetch');

function unwrapProxyResponse(res) {
  try {
    if (res && res.success === true && 'data' in res) return res.data;
  } catch {}
  return res;
}

// Very small helper to call our printful-proxy using caller's JWT
async function makeProxyCall(event, endpoint, options = {}) {
  const { method = 'GET', headers = {}, body } = options;
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
  let proxyUrl = '';
  if (siteUrl) {
    proxyUrl = `${siteUrl}/.netlify/functions/printful-proxy`;
  } else {
    const proto = (event.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = event.headers.host;
    proxyUrl = `${proto}://${host}/.netlify/functions/printful-proxy`;
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const forward = { endpoint, method, body: body || null, headers };
  const resp = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) },
    body: JSON.stringify(forward)
  });
  const raw = await resp.text();
  let json; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
  if (!resp.ok) {
    const msg = (json && json.error) ? json.error : (raw || 'Unknown error');
    throw new Error(`HTTP ${resp.status}: ${msg}`);
  }
  return json;
}

// Extract task ID from creation response
function extractTaskId(taskRes) {
  try {
    if (Array.isArray(taskRes?.data) && taskRes.data[0]?.id) return taskRes.data[0].id;
    if (taskRes?.data?.id) return taskRes.data.id;
    if (taskRes?.id) return taskRes.id;
    return null;
  } catch {
    return null;
  }
}

// Extract mockup URLs from completed task
function extractMockupUrls(taskData) {
  const urls = [];
  if (taskData?.catalog_variant_mockups && Array.isArray(taskData.catalog_variant_mockups)) {
    taskData.catalog_variant_mockups.forEach(variantMockup => {
      if (variantMockup.mockups && Array.isArray(variantMockup.mockups)) {
        variantMockup.mockups.forEach(mockup => {
          if (mockup.mockup_url) {
            urls.push({
              url: mockup.mockup_url,
              placement: mockup.placement,
              technique: mockup.technique,
              style_id: mockup.style_id,
              view: mockup.view,
              display_name: mockup.display_name
            });
          }
        });
      }
    });
  }
  return urls;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    let taskId = body.task_id || body.id;

    // Handle rate-limited retries if the client sends a retry_payload
    if (body.rate_limited && body.retry_payload) {
      console.log('[POLL-MOCKUP] Retrying rate-limited task creation');
      try {
        const taskResRaw = await makeProxyCall(event, '/v2/mockup-tasks', {
          method: 'POST',
          headers: {}, // Use default headers, proxy will add auth
          body: body.retry_payload
        });
        const taskRes = unwrapProxyResponse(taskResRaw);
        const newTaskId = extractTaskId(taskRes);
        
        if (newTaskId) {
          taskId = newTaskId; // Update taskId to the newly created one
          console.log('[POLL-MOCKUP] Rate limit retry successful, new task_id:', taskId);
        } else {
          return { statusCode: 200, headers, body: JSON.stringify({ success:false, error: 'Failed to create task after rate limit retry: No task ID returned' }) };
        }
      } catch (retryErr) {
        const isStillRateLimit = /rate limit/i.test(retryErr.message) || /429/i.test(retryErr.message);
        if (isStillRateLimit) {
          // Still rate-limited, tell client to keep polling for a retry slot
          return { statusCode: 200, headers, body: JSON.stringify({ success:true, pending:true, rate_limited: true, poll_after_ms: 30000 }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success:false, error: retryErr.message }) };
      }
    }

    if (!taskId) {
      return { statusCode: 400, headers, body: JSON.stringify({ success:false, error:'task_id is required' }) };
    }

    const apiHeaders = {};
    let resRaw;
    try {
      resRaw = await makeProxyCall(event, `/v2/mockup-tasks?id=${taskId}`, { headers: apiHeaders });
    } catch (err) {
      const msg = err && err.message ? String(err.message) : '';
      const isRateLimit = /429|rate\s*limit/i.test(msg);
      if (isRateLimit) {
        // Gracefully instruct client to back off without surfacing an error
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, pending: true, rate_limited: true, poll_after_ms: 30000, task_id: taskId }) };
      }
      throw err;
    }
    const res = unwrapProxyResponse(resRaw);

    // Unify into a single task object
    let task = null;
    if (Array.isArray(res?.data) && res.data[0]) task = res.data[0];
    else if (res?.data) task = res.data;
    else if (Array.isArray(res?.result) && res.result[0]) task = res.result[0];
    else if (res?.result) task = res.result;
    else task = res;

    const status = String(task?.status || '').toLowerCase();
    if (!status || status === 'pending' || status === 'processing') {
      return { statusCode: 200, headers, body: JSON.stringify({ success:true, pending:true, task_id: taskId }) };
    }

    if (status === 'failed' || status === 'error') {
      return { statusCode: 200, headers, body: JSON.stringify({ success:false, pending:false, task_id: taskId, error: task?.failure_reasons || 'Mockup task failed' }) };
    }

    // Completed
    console.log('[POLL-MOCKUP] Task completed, raw task data:', JSON.stringify(task, null, 2));
    const urls = extractMockupUrls(task) || [];
    console.log('[POLL-MOCKUP] Extracted URLs:', urls);
    const seen = new Set();
    const deduped = urls.filter(m => {
      if (!m || !m.url || seen.has(m.url)) return false;
      seen.add(m.url);
      return true;
    });
    console.log('[POLL-MOCKUP] Deduped URLs:', deduped);

    return { statusCode: 200, headers, body: JSON.stringify({ success:true, pending:false, task_id: taskId, urls: deduped }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success:false, error: err.message }) };
  }
};
