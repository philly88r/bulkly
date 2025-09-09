const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

export default async (req, context) => {
  // Allow CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Function removed: always return 410 Gone
  const body = {
    success: false,
    error: 'generate-mockup has been removed. Use the Printify Mockup Generator API flow instead.',
    status: 410,
  };
  return new Response(JSON.stringify(body), { status: 410, headers: corsHeaders });
};
