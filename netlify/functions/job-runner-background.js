// Netlify Background Function to run a full quick job without 30s timeouts
// Name with -background makes it a background function: it will return 202 immediately
// and continue running in the background for minutes.

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

function getOrigin(event){
  try {
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    return `${proto}://${host}`;
  } catch { return 'https://localhost:8888'; }
}

async function callProxy(event, authHeader, path, method, body) {
  const origin = getOrigin(event);
  const url = `${origin}/.netlify/functions/printify-proxy`;
  const payload = { endpoint: path, method: method || 'GET', body: body || null };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { success:false, error:'Invalid JSON from proxy', raw:text }; }
  if (!res.ok || data.success === false) {
    const err = data && (data.error || data.details?.upstream?.message) || `HTTP ${res.status}`;
    throw new Error(`Proxy call failed: ${res.status} - ${err}`);
  }
  return data; // { success:true, data }
}

async function callFn(event, authHeader, fnName, method, body) {
  const origin = getOrigin(event);
  const url = `${origin}/.netlify/functions/${fnName}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  if (!res.ok) {
    const snippet = (txt || '').slice(0, 500);
    throw new Error(`Function ${fnName} failed: ${res.status}${snippet ? ' | ' + snippet : ''}`);
  }
  try { return txt ? JSON.parse(txt) : {}; } catch { return { success:false, error:'Non-JSON from function', raw: txt }; }
}

// Extract a coarse product type from prompt text
function parseProductTypeFromPrompt(prompt) {
  const p = (prompt || '').toLowerCase();
  if (/(t[-\s]?shirt|tee|shirt)/.test(p)) return 'tshirt';
  if (/hoodie|sweatshirt/.test(p)) return 'hoodie';
  if (/tank/.test(p)) return 'tank';
  if (/long[-\s]?sleeve/.test(p)) return 'longsleeve';
  if (/mug|tumbler/.test(p)) return 'mug';
  if (/poster|canvas|print\b/.test(p)) return 'poster';
  if (/phone\s?case/.test(p)) return 'phonecase';
  if (/sticker/.test(p)) return 'sticker';
  if (/tote|bag/.test(p)) return 'tote';
  if (/pillow|cushion/.test(p)) return 'pillow';
  return 'any';
}

function chooseBlueprint(blueprints, promptText) {
  const items = blueprints?.data || [];
  if (!items.length) return null;
  const type = parseProductTypeFromPrompt(promptText);
  // Score items by match to product type and common models
  const scores = items.map(b => {
    const title = (b.title || '').toLowerCase();
    let score = 0;
    if (type === 'tshirt' && /shirt|tee/.test(title)) score += 5;
    if (type === 'hoodie' && /hoodie|sweatshirt/.test(title)) score += 5;
    if (type === 'tank' && /tank/.test(title)) score += 5;
    if (type === 'longsleeve' && /long.*sleeve/.test(title)) score += 5;
    if (type === 'mug' && /mug|tumbler/.test(title)) score += 5;
    if (type === 'poster' && /poster|canvas|print\b/.test(title)) score += 5;
    if (type === 'phonecase' && /phone.*case/.test(title)) score += 5;
    if (type === 'sticker' && /sticker/.test(title)) score += 5;
    if (type === 'tote' && /tote|bag/.test(title)) score += 5;
    if (type === 'pillow' && /pillow|cushion/.test(title)) score += 5;
    // Prefer popular apparel models if present in title
    if (/3001|bella|canvas/.test(title)) score += 2;
    if (/gildan|18500|5000/.test(title)) score += 2;
    return { b, score };
  });
  scores.sort((a,b)=> b.score - a.score);
  return (scores[0] && scores[0].score > 0) ? scores[0].b : items[0];
}

function chooseProviderWithPref(providers, pref) {
  const list = providers?.data || [];
  if (pref && typeof pref === 'string') {
    const match = list.find(p => p.title && p.title.toLowerCase().includes(pref.toLowerCase()));
    if (match) return match;
  }
  // Prefer stable providers by name if present
  const preferred = list.find(p => /monster|swift|printful|mylocker/i.test(p.title || ''));
  return preferred || list[0];
}

function getPositionPreference(prompt) {
  const p = (prompt || '').toLowerCase();
  if (/back\b/.test(p)) return 'back';
  if (/sleeve/.test(p)) return 'sleeve';
  if (/chest/.test(p)) return 'chest';
  if (/left\s?chest/.test(p)) return 'left_chest';
  if (/right\s?chest/.test(p)) return 'right_chest';
  // default
  return 'front';
}

function choosePrintArea(printAreas, prompt) {
  const pref = getPositionPreference(prompt);
  let best = null;
  let bestArea = -1;
  for (const pa of (printAreas || [])) {
    const area = (pa.width || 0) * (pa.height || 0);
    const pos = (pa.position || '').toLowerCase();
    const posMatch = pos.includes(pref) ? 1 : 0;
    const score = posMatch * 100000000 + area; // heavily weight position, then size
    if (score > bestArea) { bestArea = score; best = pa; }
  }
  if (!best && Array.isArray(printAreas) && printAreas.length) best = printAreas[0];
  return best;
}

function chooseProviderWithPref(providers, pref) {
  const list = providers?.data || [];
  if (pref && typeof pref === 'string') {
    const match = list.find(p => p.title && p.title.toLowerCase().includes(pref.toLowerCase()));
    if (match) return match;
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
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ success:false, error:'Method Not Allowed' }) };

    const authHeader = requireAuth(event);
    const body = JSON.parse(event.body || '{}');
    const jobId = body.job_id || body.jobId;
    if (!jobId) return { statusCode: 400, headers: cors, body: JSON.stringify({ success:false, error:'Missing job_id' }) };

    // Background functions return 202 immediately, then continue processing
    console.log(`[runner-bg] Handler called for job ${jobId}`);
    
    // Start processing inline (background functions keep running after sending 202)
    console.log(`[runner-bg] Starting async processing for job ${jobId}`);
    const client = createClient();
    console.log(`[runner-bg] [${jobId}] DB connect start`);
    try {
      await client.connect();
      console.log(`[runner-bg] [${jobId}] DB connect OK`);
    } catch (connErr) {
      console.error(`[runner-bg] [${jobId}] DB connect FAILED:`, connErr && (connErr.stack || connErr.message || connErr));
      // Still return 202 to the caller; background work cannot proceed
      return { statusCode: 202, headers: cors, body: JSON.stringify({ success:false, job_id: jobId, error: 'DB connect failed' }) };
    }
    try {
        let job = await getJob(client, jobId);
        if (!job) {
          console.error(`[runner-bg] Job ${jobId} not found`);
          await client.end();
          return { statusCode: 202, headers: cors, body: JSON.stringify({ success:false, job_id: jobId, error: 'Job not found' }) };
        }

        console.log(`[runner-bg] Starting background processing for job ${jobId}`);
        console.log(`[runner-bg] [${jobId}] Job snapshot: status=${job.status} total=${job.total} completed=${job.completed} failed=${job.failed} next_index=${job.next_index}`);
        
        // Move to in_progress
        if (job.status === 'queued') {
          console.log(`[runner-bg] [${jobId}] Flipping status queued -> in_progress`);
          job = await updateJob(client, jobId, { status: 'in_progress' });
          console.log(`[runner-bg] [${jobId}] Status is now ${job.status}`);
        }

        const total = Number(job.total) || 0;
        let completed = Number(job.completed) || 0;
        let failed = Number(job.failed) || 0;
        let next = Number(job.next_index) || 0;
        let results = Array.isArray(job.results) ? job.results : [];
        const params = job.params || {};
        const selectedPicks = Array.isArray(params.selectedPicks) ? params.selectedPicks : [];
        console.log(`[runner-bg] [${jobId}] Loop init: total=${total} next=${next} params.keys=${Object.keys(params).join(',')}`);

        // Process each item
        for (let i = next; i < total; i++) {
          const index = i + 1;
          let itemResult = { index, status: 'pending', step: 'init', message: 'Starting item' };
          console.log(`[${jobId}] Processing index ${index}`);
          // Persist initial progress for this item
          try {
            // Replace any existing partial result for this index
            results = Array.isArray(results) ? results.filter(r => r && r.index !== index) : [];
            results.push(itemResult);
            await updateJob(client, jobId, { results });
          } catch(e) { console.warn(`[${jobId}] Failed to persist init progress for index ${index}:`, e && (e.message||e)); }
          
          try {
            // Resolve per-item overrides from selectedPicks
            const pick = selectedPicks[i] || null;
            const overrideBlueprintId = pick && pick.blueprintId ? String(pick.blueprintId) : (params.blueprintId ? String(params.blueprintId) : null);
            const overrideProviderId = pick && pick.providerId ? String(pick.providerId) : (params.providerId ? String(params.providerId) : null);
            const overridePrintAreas = Array.isArray(pick && pick.printAreas) && pick.printAreas.length ? pick.printAreas.map(s=>String(s).toLowerCase()) : null;

            // Step 1: Fetch blueprints
            console.log(`[${jobId}] Step 1: Fetching blueprints...`);
            const blueprints = await callProxy(event, authHeader, '/v1/catalog/blueprints.json', 'GET');
            console.log(`[${jobId}] Blueprints fetched: ${(blueprints && blueprints.data && blueprints.data.length) || 0}`);
            let blueprint = null;
            const arrBps = (blueprints && blueprints.data) || [];
            if (overrideBlueprintId) {
              blueprint = arrBps.find(b => String(b.id) === String(overrideBlueprintId)) || null;
            }
            if (!blueprint) {
              blueprint = chooseBlueprint(blueprints, params.prompt || params.productScope || 'any');
            }
            if (!blueprint || !blueprint.id) throw new Error('No suitable blueprint found');
            console.log(`[${jobId}] Step 1 OK. Blueprint: ${blueprint.id} - ${blueprint.title}`);
            itemResult.step = 'blueprint'; itemResult.message = `Blueprint ${blueprint.id}`;
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step1 failed`, e && (e.message||e)); }

            // Step 2: Get providers
            const providerList = await callProxy(event, authHeader, `/v1/catalog/blueprints/${blueprint.id}/print_providers.json`, 'GET');
            console.log(`[${jobId}] Providers fetched: ${(providerList && providerList.data && providerList.data.length) || 0}`);
            let provider = null;
            const arrProv = (providerList && providerList.data) || [];
            if (overrideProviderId) {
              provider = arrProv.find(p => String(p.id) === String(overrideProviderId)) || null;
            }
            if (!provider) {
              provider = chooseProviderWithPref(providerList, params.providerPref);
            }
            if (!provider || !provider.id) throw new Error('No provider available for blueprint');
            console.log(`[${jobId}] Step 2 OK. Provider: ${provider.id}`);
            itemResult.step = 'provider'; itemResult.message = `Provider ${provider.id}`;
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step2 failed`, e && (e.message||e)); }

            // Step 3: Get print areas
            const pas = await callFn(event, authHeader, 'print-area-sizes', 'POST', { blueprintId: blueprint.id, providerId: provider.id });
            const printAreas = (pas?.data?.printAreas) || [];
            if (!printAreas.length) throw new Error('No print areas available');
            let chosen = null;
            // If user prefers specific positions, try them first
            try {
              const prefs = overridePrintAreas ? overridePrintAreas : (Array.isArray(params.printAreas) ? params.printAreas.map(s => String(s).toLowerCase()) : []);
              if (prefs.length) {
                for (const pref of prefs) {
                  const match = (printAreas || []).find(pa => String(pa.position || '').toLowerCase().includes(pref));
                  if (match) { chosen = match; break; }
                }
              }
            } catch(_) {}
            if (!chosen) {
              chosen = choosePrintArea(printAreas, params.prompt || '');
            }
            const sizeKey = `${chosen.width}x${chosen.height}`;
            const chosenPosition = (chosen.position || 'front');
            console.log(`[${jobId}] Step 3 OK. Found ${printAreas.length} print areas. Chosen position: ${chosenPosition}, size: ${sizeKey}`);
            itemResult.step = 'print-areas'; itemResult.message = `Pos ${chosenPosition} Size ${sizeKey}`;
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step3 failed`, e && (e.message||e)); }

            // Step 4: Generate/prepare image
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
              // When generating from prompt, do NOT use rembg. Instead bias the prompt.
              const promptForGen = wantsTransparent
                ? `${params.prompt || ''} with transparent background, no background`
                : (params.prompt || '');
              const giPayload = {
                prompt: promptForGen,
                numImages: 1,
                model: 'nano-banana',
                size: sizeKey,
                style: params.style || '',
                colors: params.colors || '',
                audience: params.audience || '',
                removeBackground: false
              };
              const gi = await callFn(event, authHeader, 'generate-image', 'POST', giPayload);
              imgUrl = gi?.images?.[0]?.url;
            }
            if (!imgUrl) throw new Error('Image generation/upload failed');
            console.log(`[${jobId}] Step 4 OK. Image URL ready.`);
            itemResult.step = 'image-ready'; itemResult.message = 'Image prepared'; itemResult.image_url = imgUrl;
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step4 failed`, e && (e.message||e)); }

            // Step 5: Upload to Printify (expects { url, file_name })
            const derivedName = (typeof imgUrl === 'string' && imgUrl.split('?')[0].split('/').pop()) || 'design.png';
            const ui = await callFn(event, authHeader, 'upload-image', 'POST', { url: imgUrl, file_name: derivedName });
            const printifyImageId = ui?.image_id;
            if (!printifyImageId) throw new Error('Failed to upload image to Printify');
            console.log(`[${jobId}] Step 5 OK. Printify Image ID: ${printifyImageId}`);
            itemResult.step = 'image-uploaded'; itemResult.message = `Printify image ${printifyImageId}`;
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step5 failed`, e && (e.message||e)); }

            // Step 6: Generate content (with one retry for transient 504)
            console.log(`[${jobId}] Step 6: Generating content...`);
            let gc;
            try {
              gc = await callFn(event, authHeader, 'generate-content', 'POST', {
                prompt: params.prompt,
                contentType: 'product-content',
                style: params.style,
                colors: params.colors,
                audience: params.audience,
                productInfo: [{ title: blueprint.title || 'Product', brand: params.brandPref || '' }],
                jobId: job.id
              });
            } catch (e) {
              const msg = String(e && e.message || '');
              if (/\b504\b/.test(msg)) {
                console.warn(`[${jobId}] Step 6 WARN: 504 from generate-content, retrying once in 2s...`);
                await new Promise(r=>setTimeout(r, 2000));
                gc = await callFn(event, authHeader, 'generate-content', 'POST', {
                  prompt: params.prompt,
                  contentType: 'product-content',
                  style: params.style,
                  colors: params.colors,
                  audience: params.audience,
                  productInfo: [{ title: blueprint.title || 'Product', brand: params.brandPref || '' }],
                  jobId: job.id
                });
              } else {
                throw e;
              }
            }
            if (!gc.success) throw new Error(`Content generation failed: ${gc.error}`);
            console.log(`[${jobId}] Step 6 OK. Content generated.`);
            itemResult.step = 'content-ready'; itemResult.message = 'AI content generated';
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step6 failed`, e && (e.message||e)); }

            // Step 7: Create product (use create-product.js expected schema)
            console.log(`[${jobId}] Step 7: Creating product...`);
            // Sanity log of key fields (no large payloads)
            try {
              const tagPreview = Array.isArray(gc.tags) ? gc.tags.slice(0,3) : [];
              console.log(`[${jobId}] Step 7 payload preview -> shopId=${String(job.shop_id)}, blueprint_id=${Number(blueprint.id)}, providerId=${Number(provider.id)}, position=${chosenPosition}, sizeKey=${sizeKey}, tags[0..2]=${JSON.stringify(tagPreview)}`);
            } catch(e) { /* best-effort log only */ }
            const selectedImages = {}; selectedImages[sizeKey] = printifyImageId;
            const cpPayload = {
              shopId: String(job.shop_id),
              product: { id: String(blueprint.id), title: blueprint.title || 'Product', blueprint_id: Number(blueprint.id) },
              providerId: Number(provider.id),
              printAreas: [ { position: chosenPosition || 'front', width: chosen.width, height: chosen.height } ],
              selectedImages,
              content: { title: gc.title, description: gc.description, tags: gc.tags, key_features: gc.key_features, materials: gc.materials },
              placementOverrides: {},
              markup: Number.isFinite(params.markup) ? Number(params.markup) : undefined
            };
            const cp = await callFn(event, authHeader, 'create-product', 'POST', cpPayload);
            const productId = cp?.product?.id || cp?.id;
            if (!productId) throw new Error('Product creation failed');
            console.log(`[${jobId}] Step 7 OK. Product created with ID: ${productId}`);
            itemResult.step = 'product-created'; itemResult.message = `Product ${productId}`; itemResult.product_id = productId;
            try { results = results.filter(r => r && r.index !== index); results.push(itemResult); await updateJob(client, jobId, { results }); } catch(e) { console.warn(`[${jobId}] Persist step7 failed`, e && (e.message||e)); }

            // Step 8: Publish if requested
            if (params.publishMode === 'publish') {
              console.log(`[${jobId}] Step 8: Publishing product...`);
              try {
                await callFn(event, authHeader, 'publish-product', 'POST', { product_id: productId, title: gc.title, description: gc.description });
                itemResult.status = 'published';
                console.log(`[${jobId}] Step 8 OK. Product published.`);
              } catch (e) {
                itemResult.status = 'created';
                itemResult.publish_error = String(e.message || e);
                console.log(`[${jobId}] Step 8 WARN. Product created but publish failed: ${e.message}`);
              }
            } else {
              itemResult.status = 'created';
              console.log(`[${jobId}] Step 8 OK. Product created (draft mode).`);
            }
            itemResult.title = gc.title;
            itemResult.image_url = imgUrl;
            completed++;

          } catch (err) {
            console.error(`[${jobId}] ERROR processing index ${index}:`, err && (err.stack || err.message || err));
            const raw = err && err.message ? String(err.message) : String(err || 'Unknown error');
            const safe = raw.replace(/[\u0000-\u001F]/g, ' ').slice(0, 500);
            itemResult.status = 'failed';
            itemResult.error = safe;
            itemResult.step = 'error'; itemResult.message = safe;
            failed++;
          }

          // Update final result without pushing again since we already updated itemResult in place
          next = i + 1;

          // Update progress in DB
          await updateJob(client, jobId, { completed, failed, next_index: next, results });
        }

        // Mark job as completed
        const finalStatus = failed > 0 ? (completed > 0 ? 'completed' : 'failed') : 'completed';
        await updateJob(client, jobId, { status: finalStatus });
        console.log(`[${jobId}] Background processing complete. Status: ${finalStatus}, Completed: ${completed}, Failed: ${failed}`);

      } catch (e) {
        console.error(`[runner-bg] Fatal error processing job ${jobId}:`, e && (e.stack || e.message || e));
        try {
          await updateJob(client, jobId, { status: 'failed' });
        } catch (updateErr) {
          console.error(`[runner-bg] Failed to update job status:`, updateErr);
        }
      } finally {
        await client.end();
      }

    console.log(`[runner-bg] Returning 202 for job ${jobId}`);
    return { statusCode: 202, headers: cors, body: JSON.stringify({ success:true, job_id: jobId, message: 'Background job processing started' }) };
  } catch (e) {
    console.error('quick-job-run-background error', e && (e.stack || e.message || e));
    const msg = e && e.message ? e.message : 'Internal Error';
    return { statusCode: msg==='Unauthorized'?401:500, headers: cors, body: JSON.stringify({ success:false, error: msg }) };
  }
};
