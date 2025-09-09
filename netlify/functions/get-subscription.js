const { getSupabase } = require('./_supabase_node');
const jwt = require('jsonwebtoken');

exports.handler = async (event, context) => {
    console.log('get-subscription function called');
    
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Get auth token from Authorization header
        const authHeader = event.headers.authorization || '';
        console.log('Auth header:', authHeader);
        const token = authHeader.replace('Bearer ', '');
        
        if (!token) {
            console.log('No token provided');
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized - No token provided' }) };
        }
        
        // Verify our custom JWT locally
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (e) {
            console.log('Auth error (JWT verify):', e.message);
            return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized - Invalid token' }) };
        }

        // Ensure sub is a string id
        const userId = String(decoded.sub);

        // DB client (service role)
        const supabase = getSupabase(true);

        // Get user + subscription via correct relations
        // users <- user_subscriptions (FK user_id) <- subscription_plans (FK plan_id)
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('id, user_subscriptions(*, subscription_plans(*))')
            .eq('id', userId)
            .single();

        if (userError || !userData) {
            console.log('Error fetching user data:', userError);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch user data' }) };
        }

        // Calculate subscription metrics
        // Pick the most recent active subscription if present
        const subs = Array.isArray(userData.user_subscriptions) ? userData.user_subscriptions : [];
        const activeSub = subs
            .filter(s => s.status === 'active')
            .sort((a, b) => new Date(b.current_period_end || 0) - new Date(a.current_period_end || 0))[0] || subs[0];
        const now = new Date();

        // Defaults
        let subscriptionData = {
            is_active: false,
            plan_name: 'Free',
            days_remaining: 0,
            products_per_month: 10,
            ai_generations: 50,
            products_used: 0,
            ai_used: 0
        };

        if (activeSub && activeSub.status === 'active') {
            const endDate = new Date(activeSub.current_period_end);
            const daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

            // Pull plan limits if available
            const plan = activeSub.subscription_plans || {};
            const limits = plan.limits || {};

            subscriptionData = {
                is_active: true,
                plan_name: plan.name || 'Pro',
                days_remaining: Number.isFinite(daysRemaining) ? daysRemaining : 0,
                products_per_month: limits.products_per_month || 100,
                ai_generations: limits.ai_generations || 500,
                products_used: 0,
                ai_used: 0
            };
        }

        // Determine period window for usage calculations
        const periodStart = activeSub?.current_period_start
            ? new Date(activeSub.current_period_start)
            : new Date(now.getFullYear(), now.getMonth(), 1);
        const periodEnd = activeSub?.current_period_end ? new Date(activeSub.current_period_end) : now;

        // 1) products_used: count user_products in period
        try {
            const { count: productsCount, error: productsErr } = await supabase
                .from('user_products')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('created_at', periodStart.toISOString())
                .lte('created_at', periodEnd.toISOString());
            if (!productsErr && typeof productsCount === 'number') {
                subscriptionData.products_used = productsCount;
            }
        } catch (e) {
            console.log('products_used calc error:', e.message);
        }

        // 2) ai_used: sum usage_tracking.count for ai_generations in period
        try {
            const { data: usageRows, error: usageErr } = await supabase
                .from('usage_tracking')
                .select('count')
                .eq('user_id', userId)
                .eq('type', 'ai_generations')
                .gte('created_at', periodStart.toISOString())
                .lte('created_at', periodEnd.toISOString());
            if (!usageErr && Array.isArray(usageRows)) {
                subscriptionData.ai_used = usageRows.reduce((sum, r) => sum + (r.count || 0), 0);
            }
        } catch (e) {
            console.log('ai_used calc error:', e.message);
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(subscriptionData)
        };
    } catch (error) {
        console.error('Error getting subscription:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to get subscription data' })
        };
    }
};
