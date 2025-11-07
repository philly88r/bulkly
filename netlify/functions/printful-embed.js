// Netlify Function: printful-embed
// Proxies Printful's Embedded Design Maker SDK from our own origin to satisfy CSP

exports.handler = async () => {
  try {
    const url = 'https://files.cdn.printful.com/embed/embed.js';
    const res = await fetch(url, { headers: { 'User-Agent': 'NetlifyFunction/printful-embed' } });
    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ success: false, error: `Upstream error ${res.status}` })
      };
    }
    const body = await res.text();
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        // Cache for 1 day on the edge; adjust as needed
        'cache-control': 'public, max-age=86400'
      },
      body
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: e && e.message ? e.message : String(e) })
    };
  }
};
