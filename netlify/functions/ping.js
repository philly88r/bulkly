// Simple ping function to verify function routing
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      success: true,
      message: 'Function routing works',
      timestamp: new Date().toISOString()
    })
  };
};
