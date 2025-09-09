const { createClient, getDatabaseUrl } = require('./_db');
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
}

async function ensureTable(client) {
  await client.query(`
    create table if not exists quick_jobs (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      shop_id text not null,
      params jsonb not null,
      status text not null default 'queued',
      total int not null default 0,
      completed int not null default 0,
      failed int not null default 0,
      next_index int not null default 0,
      results jsonb not null default '[]'::jsonb
    );
  `);
}

exports.handler = async (event) => {
  // Explicitly log every invocation to guarantee visibility
  console.log(`quick-job-create invoked. Method: ${event.httpMethod}. Payload:`, event.body);

  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };
    requireAuth(event);

    const body = JSON.parse(event.body || '{}');
    const { prompt, quantity, productScope, imageMode, removeBg, style, shopId } = body;

    if (!shopId) return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing shopId' }) };
    if (!prompt || typeof prompt !== 'string') return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing prompt' }) };
    // Multi-pick support: if selectedPicks provided, total equals number of picks; otherwise use quantity
    const selectedPicks = Array.isArray(body.selectedPicks) ? body.selectedPicks.filter(p => p && p.blueprintId && p.providerId) : [];
    const qty = selectedPicks.length > 0 ? selectedPicks.length : Math.min(50, Math.max(1, parseInt(quantity||1,10)));

    // Validate database configuration explicitly for clearer errors
    try { getDatabaseUrl(); } catch (cfgErr) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ success:false, error: cfgErr.message }) };
    }
    const client = createClient();
    await client.connect();
    try {
      await ensureTable(client);
      const params = {
        prompt,
        productScope: body.productScope || 'any',
        imageMode: body.imageMode || 'generate',
        removeBg: !!body.removeBg,
        style: body.style || '',
        colors: body.colors || '',
        background: body.background || null,
        consistency: body.consistency || null,
        audience: body.audience || '',
        tone: body.tone || '',
        tags: body.tags || '',
        language: body.language || 'en-US',
        providerPref: body.providerPref || '',
        brandPref: body.brandPref || '',
        printAreas: Array.isArray(body.printAreas) && body.printAreas.length ? body.printAreas : ['front'],
        variants: body.variants || 'all',
        publishMode: body.publishMode || 'draft',
        markup: Number.isFinite(body.markup) ? body.markup : 40,
        collections: body.collections || '',
        dpimin: Number.isFinite(body.dpimin) ? body.dpimin : 300,
        retryOnLowQuality: Number.isFinite(body.retryOnLowQuality) ? body.retryOnLowQuality : 1,
        pauseAfter: Number.isFinite(body.pauseAfter) ? body.pauseAfter : 0,
        uploadUrls: Array.isArray(body.uploadUrls) ? body.uploadUrls : [],
        // Multi-pick selections (each: { category, blueprintId, providerId, title, printAreas: [] })
        selectedPicks: selectedPicks.map(p => ({
          category: p.category || null,
          blueprintId: String(p.blueprintId),
          providerId: String(p.providerId),
          title: p.title || '',
          printAreas: Array.isArray(p.printAreas) ? p.printAreas : []
        }))
      };
      const res = await client.query(
        `insert into quick_jobs (shop_id, params, status, total)
         values ($1, $2, 'queued', $3)
         returning id, status, total, completed, failed`,
        [ String(shopId), params, qty ]
      );
      let row = res.rows[0];
      // Immediately mark job as in_progress so UI reflects that work has started
      try {
        const up = await client.query(
          `update quick_jobs set status = 'in_progress', updated_at = now() where id = $1 returning id, status, total, completed, failed`,
          [row.id]
        );
        if (up.rows && up.rows[0]) row = up.rows[0];
      } catch (e) {
        console.warn('Failed to flip job to in_progress immediately:', e && (e.message || e));
      }
      // Start background runner and handle startup failures immediately
      try {
        const authHeader = event.headers && (event.headers.authorization || event.headers.Authorization);
        const proto = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'])) || 'https';
        const host = event.headers && (event.headers.host || event.headers.Host);
        const origin = `${proto}://${host}`;

        console.log(`[quick-job-create] Invoking background runner for job ${row.id} at ${origin}/.netlify/functions/job-runner-background`);
        const runnerRes = await fetch(`${origin}/.netlify/functions/job-runner-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({ job_id: row.id })
        });

        if (runnerRes.status !== 202) {
          const errorText = await runnerRes.text();
          const failureMsg = `Background runner failed to start with status ${runnerRes.status}: ${errorText.slice(0, 300)}`;
          console.error(`[quick-job-create] ${failureMsg}`);
          // Mark job as failed immediately so UI knows
          await client.query(`update quick_jobs set status = 'failed', results = jsonb_build_object('error', $1::text) where id = $2`, [failureMsg, row.id]);
          throw new Error(failureMsg);
        }
        console.log(`[quick-job-create] Background runner for ${row.id} started successfully.`);
      } catch (e) {
        const errorMsg = `Failed to start background runner: ${e.message}`;
        console.error(`[quick-job-create] ${errorMsg}`);
        // Ensure job is marked as failed on any exception during startup
        try { await client.query(`update quick_jobs set status = 'failed', results = jsonb_build_object('error', $1::text) where id = $2`, [errorMsg, row.id]); } catch(dbErr){ console.error('DB update on startup failure also failed', dbErr); }
        // Re-throw to send error back to user
        throw new Error(errorMsg);
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success:true, job_id: row.id, status: row.status, total: row.total, completed: row.completed, failed: row.failed }) };
    } finally { await client.end(); }
  } catch (e) {
    try { console.error('quick-job-create error', e && (e.stack || e.message || e)); } catch {}
    const msg = e && e.message ? e.message : 'Internal Error';
    return { statusCode: msg==='Unauthorized'?401:500, headers: cors, body: JSON.stringify({ success:false, error: msg }) };
  }
};
