const { getSupabase } = require('./_supabase_node.js');

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
    const authHeader = event.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing or invalid authorization header' }) };
    }

    const token = authHeader.split(' ')[1];
    const { type, count = 1, metadata = {} } = JSON.parse(event.body);

    if (!type || !['products', 'ai_generations', 'api_calls'].includes(type)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid usage type' }) };
    }

    // Verify JWT token and get user
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET not configured');
    }

    // Import JWT library
    const jwt = require('jsonwebtoken');

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch (error) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    const userId = parseInt(payload.sub);

    const supabase = getSupabase(true);

    // Get current billing period
    const currentDate = new Date();
    const billingPeriodStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

    // Current usage aggregate
    const { data: usageRows, error: usageErr } = await supabase
      .from('usage_tracking')
      .select('type,count,created_at')
      .eq('user_id', userId)
      .gte('created_at', billingPeriodStart.toISOString());
    if (usageErr) throw new Error(`Failed to fetch usage: ${usageErr.message}`);
    const currentUsage = {};
    for (const row of usageRows || []) {
      currentUsage[row.type] = (currentUsage[row.type] || 0) + Number(row.count || 0);
    }

    // Subscription limits
    const { data: sub, error: subErr } = await supabase
      .from('user_subscriptions')
      .select('status, subscription_plans(limits)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    const limits = sub?.subscription_plans?.limits || {
      products_per_month: 50,
      ai_generations: 200,
      api_calls: 1000
    };

    // Check if adding this usage would exceed limits
    const newTotal = (currentUsage[type] || 0) + count;
    const limitKey = type === 'products' ? 'products_per_month' : 
                   type === 'ai_generations' ? 'ai_generations' : 'api_calls';
    
    if (newTotal > limits[limitKey]) {
      return { statusCode: 429, headers, body: JSON.stringify({ 
        error: `Usage limit exceeded. Current: ${currentUsage[type] || 0}, Limit: ${limits[limitKey]}`,
        current_usage: currentUsage[type] || 0,
        limit: limits[limitKey],
        upgrade_required: true
      }) };
    }

    // Record the usage
    const { data: inserted, error: insertErr } = await supabase
      .from('usage_tracking')
      .insert([
        { user_id: userId, type, count, metadata }
      ])
      .select('id,created_at')
      .single();
    if (insertErr) throw new Error(`Failed to record usage: ${insertErr.message}`);

    // Log audit event (best-effort)
    await supabase
      .from('audit_logs')
      .insert([
        {
          user_id: userId,
          action: 'usage_tracked',
          details: { type, count, new_total: newTotal, metadata }
        }
      ]);

    return { statusCode: 200, headers, body: JSON.stringify({
      success: true,
      usage_id: inserted?.id,
      current_usage: newTotal,
      limit: limits[limitKey],
      remaining: limits[limitKey] - newTotal
    }) };

  } catch (error) {
    console.error('Error tracking usage:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ 
      error: 'Internal server error',
      details: error.message 
    }) };
  }
};
