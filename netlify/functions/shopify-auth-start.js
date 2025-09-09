// Netlify Function: shopify-auth-start
// Redirects user to the Shopify app install/auth page with ?shop= param.
// Configure env SHOPIFY_APP_URL (e.g., https://your-app.example.com)

exports.handler = async (event) => {
  try {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const shop = params.get('shop') || '';

    const base = process.env.SHOPIFY_APP_URL || '';
    if (!base) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing SHOPIFY_APP_URL env var' })
      };
    }

    const dest = new URL(base);
    if (shop) dest.searchParams.set('shop', shop);

    return {
      statusCode: 302,
      headers: {
        Location: dest.toString()
      },
      body: ''
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'auth-start failed', details: String(err && err.message || err) }) };
  }
};
