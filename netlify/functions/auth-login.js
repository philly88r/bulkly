const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getSupabase } = require('./_supabase_node');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    const { email, password } = JSON.parse(event.body);

    if (!email || !password) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Email and password are required' }) 
      };
    }

    const supabase = getSupabase(true);

    // Find user by email
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return { 
        statusCode: 401, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Invalid email or password' }) 
      };
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return { 
        statusCode: 401, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Invalid email or password' }) 
      };
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        sub: user.id,
        email: user.email,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Track login
    await supabase
      .from('audit_logs')
      .insert({
        user_id: user.id,
        action: 'login',
        details: { ip: event.headers['x-forwarded-for'] || 'unknown' }
      });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          created_at: user.created_at
        }
      })
    };

  } catch (error) {
    console.error('Login error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Internal server error' })
    };
  }
};
