const DEFAULT_SUPABASE_URL = 'https://wgwexzyqaiwosgraaczi.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indnd2V4enlxYWl3b3NncmFhY3ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2ODEwNzUsImV4cCI6MjA4ODI1NzA3NX0.IS8u4SL1XeLh9KgD4c2Pl9BiGNg0zkiNauUzu_QtKH8';

function isoDate(value) {
  try {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch (_) {}
  return new Date().toISOString();
}

function escXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function fetchPublishedPosts() {
  const base = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  if (!base || !key) return [];

  const endpoint =
    base.replace(/\/+$/, '') +
    '/rest/v1/blog_posts?select=slug,city_slug,updated_at,published_at&status=eq.published&order=published_at.desc&limit=5000';

  const res = await fetch(endpoint, {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key
    }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchPublishedPostsFallback() {
  const res = await fetch('https://kiddbusy.com/api/blog-posts?limit=500');
  if (!res.ok) return [];
  const data = await res.json();
  if (!data || !Array.isArray(data.posts)) return [];
  return data.posts.map((p) => ({
    slug: p.slug,
    city_slug: p.city_slug,
    updated_at: p.updated_at || p.published_at,
    published_at: p.published_at
  }));
}

exports.handler = async function handler() {
  const baseUrl = 'https://kiddbusy.com';
  const nowIso = new Date().toISOString();

  const urls = [
    { loc: baseUrl + '/', changefreq: 'hourly', priority: '1.0', lastmod: nowIso },
    { loc: baseUrl + '/blog/', changefreq: 'daily', priority: '0.9', lastmod: nowIso },
    { loc: baseUrl + '/events.html', changefreq: 'daily', priority: '0.8', lastmod: nowIso }
  ];

  try {
    let posts = await fetchPublishedPosts();
    if (!posts.length) {
      posts = await fetchPublishedPostsFallback();
    }
    const citySeen = {};
    posts.forEach((row) => {
      const slug = String((row && row.slug) || '').trim();
      const citySlug = String((row && row.city_slug) || '').trim();
      const lastmod = isoDate((row && row.updated_at) || (row && row.published_at));

      if (slug) {
        urls.push({
          loc: baseUrl + '/blog/' + encodeURIComponent(slug),
          changefreq: 'weekly',
          priority: '0.8',
          lastmod
        });
      }

      if (citySlug && !citySeen[citySlug]) {
        citySeen[citySlug] = true;
        urls.push({
          loc: baseUrl + '/blog/city/' + encodeURIComponent(citySlug),
          changefreq: 'daily',
          priority: '0.8',
          lastmod
        });
      }
    });
  } catch (_) {}

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          '  <url>\n' +
          '    <loc>' +
          escXml(u.loc) +
          '</loc>\n' +
          '    <lastmod>' +
          escXml(u.lastmod || nowIso) +
          '</lastmod>\n' +
          '    <changefreq>' +
          escXml(u.changefreq || 'weekly') +
          '</changefreq>\n' +
          '    <priority>' +
          escXml(u.priority || '0.5') +
          '</priority>\n' +
          '  </url>'
      )
      .join('\n') +
    '\n</urlset>\n';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/xml; charset=UTF-8',
      'Cache-Control': 'public, max-age=3600'
    },
    body
  };
};
