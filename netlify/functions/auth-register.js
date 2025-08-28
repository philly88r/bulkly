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
    const { email, password, name } = JSON.parse(event.body);

    if (!email || !password || !name) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Name, email and password are required' }) 
      };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Invalid email format' }) 
      };
    }

    // Validate password strength
    if (password.length < 8) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Password must be at least 8 characters long' }) 
      };
    }

    const supabase = getSupabase(true);

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      return { 
        statusCode: 409, 
        headers, 
        body: JSON.stringify({ success: false, error: 'User with this email already exists' }) 
      };
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        name: name.trim(),
        password_hash: passwordHash,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('User creation error:', insertError);
      return { 
        statusCode: 500, 
        headers, 
        body: JSON.stringify({ success: false, error: 'Failed to create user account' }) 
      };
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        sub: newUser.id,
        email: newUser.email,
        name: newUser.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Track registration
    await supabase
      .from('audit_logs')
      .insert({
        user_id: newUser.id,
        action: 'register',
        details: { ip: event.headers['x-forwarded-for'] || 'unknown' }
      });

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          created_at: newUser.created_at
        }
      })
    };

  } catch (error) {
    console.error('Registration error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Internal server error' })
    };
  }
};
