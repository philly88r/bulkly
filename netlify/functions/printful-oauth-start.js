// netlify/functions/printful-oauth-start.js
// Starts the Printful OAuth flow by redirecting to the authorization URL.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  const clientId = process.env.PRINTFUL_CLIENT_ID;
  const redirectUri = process.env.PRINTFUL_REDIRECT_URI;
  const qs = event.queryStringParameters || {};
  const state = qs.state || '';

  if (!clientId || !redirectUri) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Missing PRINTFUL_CLIENT_ID or PRINTFUL_REDIRECT_URI env vars. Configure in Netlify env to enable OAuth.',
      }),
    };
  }

  // According to Printful docs, use installation URL format:
  // https://www.printful.com/oauth/authorize?client_id={clientId}&state={stateValue}&redirect_url={redirectUrl}
  const authUrl = new URL('https://www.printful.com/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_url', redirectUri);
  // Printful does not require response_type or scope in the authorize URL per docs
  if (state) authUrl.searchParams.set('state', state);

  return {
    statusCode: 302,
    headers: { ...headers, Location: authUrl.toString() },
    body: '',
  };
};
