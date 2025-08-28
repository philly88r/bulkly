const { getSupabase } = require('./_supabase_node.js');
const jwt = require('jsonwebtoken');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing or invalid authorization header' }) };
    }

    const token = authHeader.split(' ')[1];
    const body = JSON.parse(event.body || '{}');
    const {
      projectName,
      selectedProducts,
      productAssignments,
      bulkSettings,
      generatedDesigns,
      status = 'draft',
      step = 1
    } = body;

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET not configured');
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch (err) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    const userId = payload?.sub ?? payload?.userId;
    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid token payload' }) };
    }

    const supabase = getSupabase(true);

    const projectData = {
      type: 'bulk_project',
      selected_products: selectedProducts,
      product_assignments: productAssignments || {},
      bulk_settings: bulkSettings,
      generated_designs: generatedDesigns || [],
      current_step: step,
      created_at: new Date().toISOString()
    };

    const aiMetadata = {
      brand: bulkSettings?.brand || '',
      target_audience: bulkSettings?.targetAudience || '',
      design_prompt: bulkSettings?.designPrompt || '',
      num_products: selectedProducts?.length || 0,
      num_designs: generatedDesigns?.length || 0
    };

    const upsertTitle = projectName || `Bulk Project ${new Date().toISOString().split('T')[0]}`;
    const description = `Bulk product creation project with ${selectedProducts?.length || 0} products`;

    const { data: upserted, error: upsertErr } = await supabase
      .from('user_products')
      .upsert([
        {
          user_id: userId,
          title: upsertTitle,
          description,
          product_data: projectData,
          ai_metadata: aiMetadata,
          status: status || 'draft',
          updated_at: new Date().toISOString()
        }
      ], { onConflict: 'user_id,title' })
      .select('id')
      .single();

    if (upsertErr) throw new Error(upsertErr.message);

    const projectId = upserted.id;

    const { error: auditErr } = await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'bulk_project_saved',
          details: {
            project_id: projectId,
            project_name: projectName,
            num_products: selectedProducts?.length || 0,
            step,
            status
          }
        }
      ]);

    if (auditErr) console.warn('audit log insert failed:', auditErr);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, project_id: projectId, message: 'Bulk project saved successfully' })
    };

  } catch (error) {
    console.error('Error saving bulk project:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', details: error.message }) };
  }
};
