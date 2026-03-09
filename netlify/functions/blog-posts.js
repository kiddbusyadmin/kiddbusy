const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payload)
  };
}

async function sbGet(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase configuration missing' });
  }

  const params = event.queryStringParameters || {};
  const slug = String(params.slug || '').trim();
  const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);

  if (slug) {
    const query = `blog_posts?select=id,slug,title,excerpt,body_html,seo_description,tags,city,author,read_minutes,published_at&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`;
    const { response, data } = await sbGet(query);
    if (!response.ok) return json(response.status, { error: 'Failed to load post', details: data });
    const post = Array.isArray(data) && data.length ? data[0] : null;
    if (!post) return json(404, { error: 'Post not found' });
    return json(200, { success: true, post });
  }

  const query = `blog_posts?select=id,slug,title,excerpt,seo_description,tags,city,author,read_minutes,published_at&status=eq.published&order=published_at.desc&limit=${limit}`;
  const { response, data } = await sbGet(query);
  if (!response.ok) return json(response.status, { error: 'Failed to load posts', details: data });
  return json(200, { success: true, count: Array.isArray(data) ? data.length : 0, posts: data || [] });
};
