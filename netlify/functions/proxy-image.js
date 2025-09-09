const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ success: false, error: 'Missing url param' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Force https
    const safeUrl = target.startsWith('http://') ? target.replace('http://', 'https://') : target;

    const upstream = await fetch(safeUrl, {
      redirect: 'follow',
      headers: {
        // Some CDNs block requests without a UA
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        // Be liberal in what we accept
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
        // Set a referer to the target origin (helps some providers)
        'Referer': new URL(safeUrl).origin + '/',
      },
    });

    // Pass through body and status so Network panel shows true error codes/content
    const status = upstream.status;
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    return new Response(upstream.body, {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': ct,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
};
