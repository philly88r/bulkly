const { createClient } = require('./_db');
const fetch = require('node-fetch');

function requireAuth(event){
  const auth = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (!auth) throw new Error('Unauthorized');
}

async function getJob(client, id){
  const r = await client.query('select * from quick_jobs where id = $1', [id]);
  return r.rows[0] || null;
}

async function updateJob(client, id, patch){
  const fields = Object.keys(patch);
  const values = fields.map((k)=>{
    if (k === 'results') {
      try { return JSON.stringify(patch[k] || []); } catch { return '[]'; }
    }
    return patch[k];
  });
  const sets = fields.map((k,i)=> {
    if (k === 'results') return `${k} = $${i+1}::jsonb`;
    return `${k} = $${i+1}`;
  });
  const sql = `update quick_jobs set ${sets.join(', ')}, updated_at = now() where id = $${fields.length+1} returning *`;
  const res = await client.query(sql, [...values, id]);
  return res.rows[0];
}

// ---- Helpers to call internal functions with auth passthrough ----
function getOrigin(event){
  try {
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    if (host) return `${proto}://${host}`;
  } catch {}
  return process.env.URL || '';
}

async function callProxy(event, authHeader, endpoint, method = 'GET', body = undefined) {
  const origin = getOrigin(event);
  const url = origin ? `${origin}/.netlify/functions/printify-proxy` : `${process.env.URL}/.netlify/functions/printify-proxy`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ endpoint, method, body })
  });
  const json = await resp.json().catch(()=>({ success:false, error:'Bad JSON' }));
  if (!resp.ok || !json.success) throw new Error(json.error || `Proxy ${endpoint} failed`);
  return json.data;
}

async function callFn(event, authHeader, name, method = 'POST', payload = {}) {
  const origin = getOrigin(event);
  const url = `${origin}/.netlify/functions/${name}`;
  const resp = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: authHeader }, body: method==='GET'?undefined:JSON.stringify(payload) });
  const json = await resp.json().catch(()=>({ success:false, error:'Bad JSON'}));
  if (!resp.ok || json.success === false) throw new Error(json.error || `${name} failed`);
  return json;
}

function mapScopeToFilter(scope) {
  const s = String(scope||'any').toLowerCase();
  if (s.includes('tshirt') || s.includes('t-shirt')) return { include: ['shirt','t-shirt'], exclude: ['mug','poster','canvas'] };
  if (s.includes('hood')) return { include: ['hood'], exclude: [] };
  if (s.includes('mug')) return { include: ['mug'], exclude: [] };
  if (s.includes('poster') || s.includes('canvas')) return { include: ['poster','canvas'], exclude: [] };
  if (s.includes('apparel')) return { include: ['shirt','hood','sweat','apparel'], exclude: ['mug','poster','canvas'] };
  return { include: ['shirt','hood','mug','poster'], exclude: [] };
}

function chooseBlueprint(catalog, scope) {
  const filter = mapScopeToFilter(scope);
  const arr = Array.isArray(catalog) ? catalog : (catalog.blueprints || []);
  const list = arr.filter(b => {
    const t = (b.title || b.name || '').toLowerCase();
    const passInclude = filter.include.length ? filter.include.some(k => t.includes(k)) : true;
    const passExclude = filter.exclude.length ? !filter.exclude.some(k => t.includes(k)) : true;
    return passInclude && passExclude;
  });
  return (list[0] || arr[0] || null);
}

function firstProvider(providers) {
  if (Array.isArray(providers) && providers.length) return providers[0];
  if (providers && providers.data && Array.isArray(providers.data) && providers.data.length) return providers.data[0];
  return null;
}

function chooseProviderWithPref(providers, pref) {
  const list = Array.isArray(providers) ? providers : (providers?.data || []);
  if (!list.length) return null;
  if (pref && typeof pref === 'string') {
    const p = pref.toLowerCase();
    const hit = list.find(pr => (pr.title || pr.name || '').toLowerCase().includes(p));
    if (hit) return hit;
  }
  return list[0];
}

function uniqueSizesFromAreas(areas) {
  const map = new Map();
  (areas||[]).forEach(a => { const key = `${a.width}x${a.height}`; if (!map.has(key)) map.set(key, { key, width:a.width, height:a.height }); });
  return [...map.values()];
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    requireAuth(event);

    const params = event.queryStringParameters || {};
    const jobId = params.job_id;
    const tick = String(params.tick||'').toLowerCase() === 'true';
    if (!jobId) return { statusCode: 400, body: JSON.stringify({ success:false, error:'Missing job_id' }) };

    const client = createClient();
    await client.connect();
    try {
      let job = await getJob(client, jobId);
      if (!job) return { statusCode: 404, body: JSON.stringify({ success:false, error:'Job not found' }) };

      // Minimal tick scaffolding: move from queued -> in_progress and process a small batch
      if (tick) {
        if (job.status === 'queued') {
          job = await updateJob(client, jobId, { status: 'in_progress' });
        }
        if (job.status === 'in_progress') {
          const BATCH_SIZE = 1; // process one fully per tick for reliability
          const total = Number(job.total) || 0;
          const next = Number(job.next_index) || 0;
          const completed = Number(job.completed) || 0;
          const failed = Number(job.failed) || 0;
          let results = Array.isArray(job.results) ? job.results : [];

          const remaining = Math.max(0, total - next);
          const toProcess = Math.min(BATCH_SIZE, remaining);

          if (toProcess > 0) {
            const params = job.params || {};
            const authHeader = event.headers.authorization || event.headers.Authorization || '';
            for (let i = 0; i < toProcess; i++) {
              const index = next + i + 1;
              let itemResult = { index, status: 'pending' };
              console.log(`[${jobId}] Processing index ${index}`);
              try {
                console.log(`[${jobId}] Step 1: Fetching blueprints...`);
                // 1) Catalog blueprints
                const blueprints = await callProxy(event, authHeader, '/v1/catalog/blueprints.json', 'GET');
                const blueprint = chooseBlueprint(blueprints, params.productScope || 'any');
                if (!blueprint || !blueprint.id) throw new Error('No suitable blueprint found');
                console.log(`[${jobId}] Step 1 OK. Blueprint: ${blueprint.id} - ${blueprint.title}`);

                // 2) Providers for blueprint
                const providerList = await callProxy(event, authHeader, `/v1/catalog/blueprints/${blueprint.id}/print_providers.json`, 'GET');
                const provider = chooseProviderWithPref(providerList, params.providerPref);
                if (!provider || !provider.id) throw new Error('No provider available for blueprint');
                console.log(`[${jobId}] Step 2 OK. Provider: ${provider.id}`);

                // 3) Print areas via dedicated function (gets dimensions)
                const pas = await callFn(event, authHeader, 'print-area-sizes', 'POST', { blueprintId: blueprint.id, providerId: provider.id });
                const printAreas = (pas?.data?.printAreas) || [];
                if (!printAreas.length) throw new Error('No print areas available');
                const sizeGroups = uniqueSizesFromAreas(printAreas);
                const chosenSize = sizeGroups[0];
                const sizeKey = `${chosenSize.width}x${chosenSize.height}`;
                console.log(`[${jobId}] Step 3 OK. Found ${printAreas.length} print areas. Chosen size: ${sizeKey}`);

                // 4) Produce image: either use uploaded URL(s) or generate
                let imgUrl = null;
                const wantsTransparent = params.removeBg || (params.background === 'transparent');
                console.log(`[${jobId}] Step 4: Preparing image... Mode: ${params.imageMode}`);
                if ((params.imageMode === 'upload') && Array.isArray(params.uploadUrls) && params.uploadUrls.length) {
                  const pick = params.uploadUrls[(index - 1) % params.uploadUrls.length];
                  if (!pick) throw new Error('No upload URL available');
                  if (wantsTransparent) {
                    const rem = await callFn(event, authHeader, 'generate-image', 'POST', { model: 'rembg', imageUrl: pick, prompt: 'remove background', numImages: 1, size: sizeKey });
                    imgUrl = rem?.images?.[0]?.url || null;
                  } else {
                    imgUrl = pick;
                  }
                } else {
                  const giPayload = {
                    prompt: params.prompt,
                    numImages: 1,
                    model: 'nano-banana',
                    size: sizeKey,
                    style: params.style || '',
                    colors: params.colors || '',
                    audience: params.audience || '',
                    removeBackground: wantsTransparent
                  };
                  const gi = await callFn(event, authHeader, 'generate-image', 'POST', giPayload);
                  imgUrl = gi?.images?.[0]?.url;
                }
                if (!imgUrl) throw new Error('Image generation/upload failed');
                console.log(`[${jobId}] Step 4 OK. Image URL ready.`);

                // 5) Upload image to Printify to get image_id
                const up = await callFn(event, authHeader, 'upload-image', 'POST', { url: imgUrl, file_name: `quickai_${Date.now()}_${sizeKey}.png` });
                const imageId = up?.image_id;
                if (!imageId) throw new Error('Upload image failed');
                const selectedImages = { [sizeKey]: imageId };
                console.log(`[${jobId}] Step 5 OK. Printify Image ID: ${imageId}`);

                // 6) Generate product content (with retry logic for 503 errors)
                let gc, gcJson;
                const MAX_RETRIES = 3;
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                  console.log(`[${jobId}] Step 6: Generating content (attempt ${attempt}/${MAX_RETRIES})...`);
                  gc = await fetch(getOrigin(event) + '/.netlify/functions/generate-content', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
                    body: JSON.stringify({
                      prompt: params.prompt,
                      contentType: 'product-content',
                      style: params.style,
                      colors: params.colors,
                      audience: params.audience,
                      productInfo: [{ title: blueprint.title || 'Product', brand: params.brandPref || '' }],
                      jobId: job.id
                    })
                  });

                  if (gc.status !== 503 && gc.status !== 502) {
                    break; // Exit loop on success or non-retryable error
                  }

                  console.log(`[${jobId}] Step 6: Received ${gc.status} (transient), waiting 1s to retry...`);
                  if (attempt < MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                  }
                }

                gcJson = await gc.json().catch(()=>({ success:false }));
                if (!gc.ok || gcJson.success === false) {
                    const errorDetail = gcJson.error || `generate-content failed with status ${gc.status}`;
                    throw new Error(errorDetail);
                }
                console.log(`[${jobId}] Step 6 OK. Content generated.`);

                const content = {
                  title: gcJson.title,
                  description: gcJson.description,
                  tags: gcJson.tags,
                  key_features: gcJson.key_features,
                  materials: gcJson.materials
                };

                // 7) Build minimal product object
                const product = {
                  id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  title: content.title || (blueprint.title || 'AI Product'),
                  description: content.description || '',
                  blueprint_id: blueprint.id
                };

                // Map print areas positions for create-product
                const positions = (params.printAreas && params.printAreas.length) ? params.printAreas : ['front'];
                const filteredAreas = printAreas.filter(a => positions.includes(a.position) || positions.includes(a.position?.replace('_chest','')));
                const printAreasPayload = filteredAreas.map(a => ({ position: a.position, width: a.width, height: a.height }));

                // 8) Create product
                const cpPayload = {
                  shopId: String(job.shop_id),
                  product,
                  providerId: provider.id,
                  printAreas: printAreasPayload,
                  selectedImages,
                  content,
                  placementOverrides: {}
                };
                console.log(`[${jobId}] Step 7: Calling create-product with payload...`);
                const cp = await callFn(event, authHeader, 'create-product', 'POST', cpPayload);
                const created = cp?.product;
                console.log(`[${jobId}] Step 8 OK. Product created with ID: ${created?.id}`);

                itemResult = {
                  index,
                  status: 'created',
                  title: created?.title || product.title,
                  product_id: created?.id || null,
                  shop_id: job.shop_id,
                  blueprint_id: blueprint.id,
                  provider_id: provider.id
                };

                // 9) Optional auto-publish
                try {
                  if (String(params.publishMode||'draft').toLowerCase() === 'publish' && created?.id) {
                    const pub = await callFn(event, authHeader, 'publish-product', 'POST', { shopId: String(job.shop_id), productId: String(created.id) });
                    if (pub && pub.success !== false) {
                      itemResult.status = 'published';
                    }
                  }
                } catch (e) {
                  // Keep created status if publish fails
                  itemResult.publish_error = String(e.message || e);
                }
                results.push(itemResult);
              } catch (err) {
                console.error(`[${jobId}] ERROR processing index ${index}:`, err);
                // Ensure error string is JSONB-safe: strip control chars and truncate
                const raw = err && err.message ? String(err.message) : String(err || 'Unknown error');
                const safe = raw.replace(/[\u0000-\u001F]/g, ' ').slice(0, 500);
                results.push({ index, status: 'failed', error: safe });
              }
            }
            const successInBatch = results.slice(-toProcess).filter(r => r.status==='created').length;
            const failInBatch = toProcess - successInBatch;
            const newCompleted = completed + successInBatch;
            const newFailed = failed + failInBatch;
            const newNext = next + toProcess;
            let patch = { completed: newCompleted, failed: newFailed, next_index: newNext, results };
            if (newCompleted + newFailed >= total) {
              patch.status = 'completed';
            }
            job = await updateJob(client, jobId, patch);
          }
        }
      }

      const payload = {
        success: true,
        job_id: job.id,
        status: job.status,
        total: job.total,
        completed: job.completed,
        failed: job.failed,
        results: job.results || []
      };
      return { statusCode: 200, body: JSON.stringify(payload) };
    } finally { await client.end(); }
  } catch (e) {
    console.error('quick-job-status error', e);
    const msg = e && e.message ? e.message : 'Internal Error';
    return { statusCode: msg==='Unauthorized'?401:500, body: JSON.stringify({ success:false, error: msg }) };
  }
};
