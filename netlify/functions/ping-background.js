// /netlify/functions/ping-background.js
// A minimal background function to test deployment.

exports.handler = async (event) => {
  // This log should appear immediately when the function is called.
  console.log('[ping-background] Handler invoked.');

  // This part runs in the background after the 202 response is sent.
  setTimeout(() => {
    console.log('[ping-background] Async operation completed after 2 seconds.');
  }, 2000);

  return {
    statusCode: 202,
    body: 'Ping background task accepted.',
  };
};
