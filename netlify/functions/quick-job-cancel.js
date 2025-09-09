const { createClient } = require('./_db');

function requireAuth(event){
  const auth = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (!auth) throw new Error('Unauthorized');
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    requireAuth(event);

    const body = JSON.parse(event.body || '{}');
    const jobId = body.job_id;
    if (!jobId) return { statusCode: 400, body: JSON.stringify({ success:false, error:'Missing job_id' }) };

    const client = createClient();
    await client.connect();
    try {
      const r = await client.query('update quick_jobs set status = $1, updated_at = now() where id = $2 returning id, status, total, completed, failed, results', ['cancelled', jobId]);
      if (!r.rowCount) return { statusCode: 404, body: JSON.stringify({ success:false, error:'Job not found' }) };
      const row = r.rows[0];
      return { statusCode: 200, body: JSON.stringify({ success:true, job_id: row.id, status: row.status, total: row.total, completed: row.completed, failed: row.failed, results: row.results || [] }) };
    } finally { await client.end(); }
  } catch (e) {
    console.error('quick-job-cancel error', e);
    const msg = e && e.message ? e.message : 'Internal Error';
    return { statusCode: msg==='Unauthorized'?401:500, body: JSON.stringify({ success:false, error: msg }) };
  }
};
