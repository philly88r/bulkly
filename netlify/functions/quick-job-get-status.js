// Lightweight status endpoint for quick jobs
// Returns the current state of quick_jobs without advancing work.

const { createClient } = require('./_db');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function requireAuth(event){
  const auth = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (!auth) throw new Error('Unauthorized');
}

async function getJob(client, id){
  const r = await client.query('select * from quick_jobs where id = $1', [id]);
  return r.rows[0] || null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };
    requireAuth(event);

    const body = JSON.parse(event.body || '{}');
    const jobId = body.job_id || body.jobId;
    if (!jobId) return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing job_id' }) };

    const client = createClient();
    await client.connect();
    try {
      const job = await getJob(client, jobId);
      if (!job) return { statusCode: 404, headers: cors, body: JSON.stringify({ success:false, error:'Job not found' }) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success:true, job, job_id: job.id }) };
    } finally {
      await client.end();
    }
  } catch (e) {
    const msg = e && e.message ? e.message : 'Internal Error';
    const status = msg === 'Unauthorized' ? 401 : 500;
    return { statusCode: status, headers: cors, body: JSON.stringify({ success:false, error: msg }) };
  }
};
