const { getSupabase } = require('./_supabase_node.js');
const jwt = require('jsonwebtoken');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const authHeader = event.headers.authorization;
    console.log('Auth header:', authHeader ? 'Present' : 'Missing');
    
    if (!authHeader?.startsWith('Bearer ')) {
      console.log('Invalid auth header format');
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Missing or invalid authorization header' })
      };
    }

    const token = authHeader.split(' ')[1];
    console.log('Token extracted:', token ? 'Present' : 'Missing');

    // Verify JWT token and get user
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.log('JWT_SECRET not configured');
      throw new Error('JWT_SECRET not configured');
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
      console.log('Token verified successfully, userId:', payload.sub);
    } catch (error) {
      console.log('Token verification failed:', error.message);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid token', details: error.message })
      };
    }

    const userId = parseInt(payload.sub);

    const supabase = getSupabase(true);

    // Get current billing period
    const currentDate = new Date();
    const billingPeriodStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

    // Fetch usage rows for this billing period and aggregate in code
    const { data: usageRows, error: usageErr } = await supabase
      .from('usage_tracking')
      .select('type,count,created_at')
      .eq('user_id', userId)
      .gte('created_at', billingPeriodStart.toISOString());
    if (usageErr) {
      throw new Error(`Failed to fetch usage: ${usageErr.message}`);
    }

    const usage = { products: 0, ai_generations: 0, api_calls: 0 };
    for (const row of usageRows || []) {
      usage[row.type] = (usage[row.type] || 0) + Number(row.count || 0);
    }

    // Fetch active subscription limits
    const { data: sub, error: subErr } = await supabase
      .from('user_subscriptions')
      .select('status, subscription_plans(name,limits)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    const limits = sub?.subscription_plans?.limits || {
      products_per_month: 50,
      ai_generations: 200,
      api_calls: 1000
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        usage,
        limits,
        billing_period_start: billingPeriodStart.toISOString(),
        remaining: {
          products: Math.max(0, limits.products_per_month - usage.products),
          ai_generations: Math.max(0, limits.ai_generations - usage.ai_generations),
          api_calls: Math.max(0, limits.api_calls - usage.api_calls)
        }
      })
    };

  } catch (error) {
    console.error('Error getting usage:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message 
      })
    };
  }
};
