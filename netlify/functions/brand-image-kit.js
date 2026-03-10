const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const PHOTO_BUCKET = process.env.PHOTO_UPLOAD_BUCKET || 'listing-photos';

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function safeText(value, max) {
  return String(value || '').trim().slice(0, max || 200);
}

function cleanSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function uploadBinaryToStorage(path, bytes, mimeType) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType || 'image/png',
      'x-upsert': 'true'
    },
    body: bytes
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

async function callOpenAiImage(prompt, opts) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: opts.model || OPENAI_IMAGE_MODEL,
      prompt: prompt,
      size: opts.size || '1024x1024',
      quality: opts.quality || 'high'
    })
  });
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : 'OpenAI image generation failed';
    throw new Error(message);
  }
  const item = data && Array.isArray(data.data) && data.data[0] ? data.data[0] : null;
  if (!item) throw new Error('OpenAI returned no image');
  if (item.b64_json) return { bytes: Buffer.from(String(item.b64_json), 'base64'), mimeType: 'image/png' };
  if (item.url) {
    const dl = await fetch(String(item.url));
    if (!dl.ok) throw new Error('Failed to download generated image URL');
    return { bytes: Buffer.from(await dl.arrayBuffer()), mimeType: dl.headers.get('content-type') || 'image/png' };
  }
  throw new Error('OpenAI response missing b64_json/url');
}

function profilePrompts(brandName) {
  const base = `Instagram profile photo only for "${brandName}". Must be square, highly legible at tiny size, no tiny text, no watermark, clean background, family-friendly, playful but polished.`;
  return [
    {
      label: 'Playful K Badge',
      prompt: `${base} Create a bold monogram K icon in bright teal/coral/yellow with soft rounded geometry and subtle smile motif.`
    },
    {
      label: 'Map Pin Family Mark',
      prompt: `${base} Create a modern location pin icon combined with a simple family/child silhouette, flat vector style, warm vibrant palette.`
    },
    {
      label: 'Sunburst Compass',
      prompt: `${base} Create a sunburst + compass symbol representing discovery and local adventures, clean geometric vector, high contrast.`
    },
    {
      label: 'Ticket Spark',
      prompt: `${base} Create a playful ticket-stub shaped emblem with spark/star accents to represent fun activities, no words, crisp vector mark.`
    },
    {
      label: 'Balloon Path',
      prompt: `${base} Create a minimal hot-air balloon/path icon symbolizing local exploration with kids, polished brand mark, simple strong shapes.`
    }
  ];
}

function heroBackgroundPrompts(brandName) {
  const base = `Website hero background art for "${brandName}" behind a search box. Must keep center area visually calm for text legibility. No text, no logos, no letters, no watermark, no faces. Family-friendly, modern, playful, premium.`;
  return [
    {
      label: 'Playful Paper Cut Shapes',
      prompt: `${base} Layered organic paper-cut shapes with teal, sky blue, coral, warm yellow; subtle depth and soft shadows; clean negative space in center.`
    },
    {
      label: 'Balloon Sky Gradient',
      prompt: `${base} Bright sky gradient with abstract balloon/path motifs around edges, center clean and lightly textured, energetic but not busy.`
    },
    {
      label: 'City Park Abstract',
      prompt: `${base} Abstract city-park scene with stylized trees and pathways, edge-focused detail, center soft glow for search box readability.`
    },
    {
      label: 'Confetti Wave Motion',
      prompt: `${base} Dynamic curved ribbons and confetti dots sweeping from corners, high-contrast color pops, center kept open and calm.`
    },
    {
      label: 'Sunburst Discovery',
      prompt: `${base} Soft radial sunburst with geometric exploration icons abstracted into shapes, cheerful palette, center reserved and uncluttered.`
    }
  ];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase service configuration missing' });
  if (!OPENAI_API_KEY) return json(500, { error: 'OPENAI_API_KEY missing' });

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const action = safeText(body.action, 80) || 'generate_ig_profile_options';
  if (
    action !== 'generate_ig_profile_options' &&
    action !== 'generate_ig_profile_option' &&
    action !== 'generate_search_background_options' &&
    action !== 'generate_search_background_option'
  ) {
    return json(400, { error: 'Unsupported action' });
  }
  const brandName = safeText(body.brand_name, 80) || 'KiddBusy';
  const isHeroMode = action === 'generate_search_background_options' || action === 'generate_search_background_option';
  const prompts = isHeroMode ? heroBackgroundPrompts(brandName) : profilePrompts(brandName);
  const requestedSize = safeText(body.size, 20);
  const requestedQuality = safeText(body.quality, 20);
  const promptTweak = safeText(body.prompt_tweak, 700);
  const stamp = Date.now();
  const generateOne = async (idx) => {
    const optionIndex = Math.max(1, Math.min(prompts.length, Number(idx) || 1));
    const baseItem = prompts[optionIndex - 1];
    const item = {
      label: baseItem.label,
      prompt: promptTweak ? (baseItem.prompt + '\n' + promptTweak) : baseItem.prompt
    };
    const img = await callOpenAiImage(item.prompt, {
      size: requestedSize || '1024x1024',
      quality: requestedQuality || (isHeroMode ? 'medium' : 'high'),
      model: OPENAI_IMAGE_MODEL
    });
    const folder = isHeroMode ? 'search-backgrounds' : 'instagram';
    const path = `branding/${folder}/${cleanSegment(brandName)}/${stamp}-${optionIndex}.png`;
    const upload = await uploadBinaryToStorage(path, img.bytes, img.mimeType);
    if (!upload.response.ok) {
      throw new Error('Storage upload failed');
    }
    return {
      option: optionIndex,
      label: item.label,
      prompt: item.prompt,
      image_url: `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`
    };
  };

  if (action === 'generate_ig_profile_option' || action === 'generate_search_background_option') {
    try {
      const one = await generateOne(body.option || 1);
      return json(200, {
        success: true,
        brand_name: brandName,
        mode: isHeroMode ? 'search_background' : 'instagram_profile',
        count: 1,
        model_used: OPENAI_IMAGE_MODEL,
        options: [one]
      });
    } catch (err) {
      return json(500, { error: err.message || 'Option generation failed' });
    }
  }

  // Multi-option path (kept for compatibility; may time out on some providers).
  const out = [];
  for (let i = 1; i <= prompts.length; i += 1) {
    out.push(await generateOne(i));
  }
  return json(200, {
    success: true,
    brand_name: brandName,
    mode: isHeroMode ? 'search_background' : 'instagram_profile',
    count: out.length,
    model_used: OPENAI_IMAGE_MODEL,
    options: out
  });
};
