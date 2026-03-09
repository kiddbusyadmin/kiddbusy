// netlify/functions/telegram-webhook.js
// Receives messages from Telegram, runs the KiddBusy agent, replies

const SUPABASE_URL = process.env.KB_DB_URL || 'https://wgwexzyqaiwosgraaczi.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // your personal chat ID

// ---- TELEGRAM ----
async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    })
  });
  return res.json();
}

// ---- SUPABASE ----
async function dbQuery(table, params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=100`;
  if (params.eq) {
    for (const [col, val] of Object.entries(params.eq)) {
      url += `&${col}=eq.${encodeURIComponent(val)}`;
    }
  }
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB query failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function dbUpdate(table, id, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) throw new Error(`DB update failed (${res.status}): ${await res.text()}`);
  return { success: true };
}

// ---- EMAIL ----
async function sendEmail(to, subject, body, fromName = 'KiddBusy') {
  const isHtml = body.trim().startsWith('<');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${fromName} <admin@kiddbusy.com>`,
      to: [to],
      subject,
      ...(isHtml ? { html: body } : { text: body })
    })
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message || 'Email failed');
  return result;
}

// ---- TOOL EXECUTOR ----
async function executeTool(name, input) {
  switch (name) {
    case 'query_submissions': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('submissions', { eq });
      return { count: data.length, submissions: data };
    }
    case 'query_reviews': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('reviews', { eq });
      return { count: data.length, reviews: data };
    }
    case 'query_sponsorships': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('sponsorships', { eq });
      return { count: data.length, sponsorships: data };
    }
    case 'query_listings': {
      const data = await dbQuery('listings');
      return { count: data.length, listings: data };
    }
    case 'update_submission_status':
      await dbUpdate('submissions', input.id, { status: input.status });
      return { success: true, id: input.id, new_status: input.status };
    case 'update_review_status':
      await dbUpdate('reviews', input.id, { status: input.status });
      return { success: true, id: input.id, new_status: input.status };
    case 'update_sponsorship_status':
      await dbUpdate('sponsorships', input.id, { status: input.status });
      return { success: true, id: input.id, new_status: input.status };
    case 'send_email':
      await sendEmail(input.to, input.subject, input.body, input.from_name || 'KiddBusy');
      return { success: true, to: input.to };
    case 'send_telegram': {
      const chatId = TELEGRAM_ALLOWED_CHAT_ID;
      await sendTelegram(chatId, input.message);
      return { success: true };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- CLAUDE AGENT ----
async function runAgent(userMessage) {
  const tools = [
    { name: 'query_submissions', description: 'Query submissions.', input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: [] } },
    { name: 'query_reviews', description: 'Query reviews.', input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: [] } },
    { name: 'query_sponsorships', description: 'Query sponsorships.', input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: [] } },
    { name: 'query_listings', description: 'Query listings.', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'update_submission_status', description: 'Approve or reject a submission.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['id', 'status'] } },
    { name: 'update_review_status', description: 'Approve or reject a review.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['id', 'status'] } },
    { name: 'update_sponsorship_status', description: 'Update sponsorship status.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'status'] } },
    { name: 'send_email', description: 'Send an email from admin@kiddbusy.com.', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, from_name: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
    { name: 'send_telegram', description: 'Send a Telegram message to the admin.', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }
  ];

  const systemPrompt = `You are the KiddBusy admin agent. You manage a family activity directory. You are responding to a Telegram message from Harold, the owner.

You have access to the database (submissions, reviews, sponsorships, listings) and can query, approve, reject, and send emails.

Be concise — this is a chat interface. Use plain text, not HTML. When Harold asks for a status update, query the DB and summarize briefly. When he gives you an instruction, execute it and confirm. Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;

  let messages = [{ role: 'user', content: userMessage }];
  let iterations = 0;

  while (iterations < 15) {
    iterations++;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Anthropic error: ${err.error?.message}`);
    }

    const response = await res.json();

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUses) {
        let result;
        try {
          result = await executeTool(toolUse.name, toolUse.input);
        } catch (e) {
          result = { error: e.message };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    } else {
      return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  }
  throw new Error('Agent exceeded max iterations');
}

// ---- NETLIFY HANDLER ----
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'OK' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: 'OK' };
  }

  const message = body.message;
  if (!message) return { statusCode: 200, body: 'OK' };

  const chatId = String(message.chat.id);
  const text = message.text || '';

  // Security: only respond to your chat ID
  if (TELEGRAM_ALLOWED_CHAT_ID && chatId !== TELEGRAM_ALLOWED_CHAT_ID) {
    await sendTelegram(chatId, 'Unauthorized.');
    return { statusCode: 200, body: 'OK' };
  }

  // Acknowledge immediately (Telegram has a 5s timeout)
  // Run agent async — we'll send the response via sendTelegram
  try {
    await sendTelegram(chatId, '⏳ On it...');
    const reply = await runAgent(text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    await sendTelegram(chatId, `❌ Error: ${err.message}`);
  }

  return { statusCode: 200, body: 'OK' };
};
