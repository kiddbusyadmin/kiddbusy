exports.handler = async function handler() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, message: 'Cron trigger now handled by cmo-blog-run-background schedule.' })
  };
};
