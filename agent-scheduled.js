// Autonomous KiddBusy Agent - runs on a schedule
// Processes pending submissions, reviews, sponsorships, and sends appropriate emails

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wgbdwpbexfcxijcrxyii.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

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

// ---- SUPABASE TOOLS ----
function getDb() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function queryTable(table, filters = {}) {
  const db = getDb();
  let q = db.from(table).select('*').order('created_at', { ascending: false }).limit(100);
  for (const [key, val] of Object.entries(filters)) {
    q = q.eq(key, val);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function updateRecord(table, id, updates) {
  const db = getDb();
  const { error } = await db.from(table).update(updates).eq('id', id);
  if (error) throw new Error(error.message);
}

async function getDirectives() {
  try {
    const db = getDb();
    const { data } = await db.from('directives').select('*');
    return Object.fromEntries((data || []).map(d => [d.key, d.value]));
  } catch {
    return {};
  }
}

// ---- TOOL EXECUTOR (called by Claude) ----
async function executeTool(name, input, log) {
  log(`  [tool] ${name}: ${JSON.stringify(input)}`);
  try {
    switch (name) {
      case 'query_submissions': {
        const filters = {};
        if (input.status && input.status !== 'all') filters.status = input.status;
        const data = await queryTable('submissions', filters);
        return { count: data.length, submissions: data };
      }
      case 'query_reviews': {
        const filters = {};
        if (input.status && input.status !== 'all') filters.status = input.status;
        const data = await queryTable('reviews', filters);
        return { count: data.length, reviews: data };
      }
      case 'query_sponsorships': {
        const filters = {};
        if (input.status && input.status !== 'all') filters.status = input.status;
        const data = await queryTable('sponsorships', filters);
        return { count: data.length, sponsorships: data };
      }
      case 'query_listings': {
        const data = await queryTable('listings', {});
        return { count: data.length, listings: data };
      }
      case 'update_submission_status': {
        await updateRecord('submissions', input.id, { status: input.status });
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_review_status': {
        await updateRecord('reviews', input.id, { status: input.status });
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_sponsorship_status': {
        await updateRecord('sponsorships', input.id, { status: input.status });
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'get_directives': {
        const directives = await getDirectives();
        return { directives };
      }
      case 'send_email': {
        await sendEmail(input.to, input.subject, input.body, input.from_name || 'KiddBusy');
        return { success: true, to: input.to, subject: input.subject };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ---- CLAUDE AGENTIC LOOP ----
async function runAgent(task, log) {
  const tools = [
    {
      name: 'query_submissions',
      description: 'Get submissions from the database.',
      input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'all'] } }, required: [] }
    },
    {
      name: 'query_reviews',
      description: 'Get reviews from the database.',
      input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: [] }
    },
    {
      name: 'query_sponsorships',
      description: 'Get sponsorships from the database.',
      input_schema: { type: 'object', properties: { status: { type: 'string' } }, required: [] }
    },
    {
      name: 'query_listings',
      description: 'Get approved listings.',
      input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'update_submission_status',
      description: 'Approve or reject a submission.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['id', 'status'] }
    },
    {
      name: 'update_review_status',
      description: 'Approve or reject a review.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['id', 'status'] }
    },
    {
      name: 'update_sponsorship_status',
      description: 'Update sponsorship status.',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['active', 'cancelled', 'pending'] } }, required: ['id', 'status'] }
    },
    {
      name: 'get_directives',
      description: 'Get agent directives and configuration.',
      input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'send_email',
      description: 'Send an email via Resend from admin@kiddbusy.com.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'HTML email body' },
          from_name: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  ];

  const systemPrompt = `You are the autonomous KiddBusy business agent. You run every morning to keep the business running smoothly without any human involvement.

Your job today:
1. Check all pending submissions — review each one. If it looks like a legitimate kid-friendly business with enough info, approve it and send the appropriate email. If missing info or a duplicate, reject it with the right email.
2. Check all pending reviews — approve genuine helpful reviews, reject spam or inappropriate ones.
3. Check pending sponsorships — send a welcome/inquiry received email to any new ones that haven't been contacted yet.
4. Send a daily summary email to admin@kiddbusy.com at the end with what you did.

EMAIL TEMPLATES — use these exactly, personalized with real data:

SUBMISSION APPROVED (is_owner = true):
Subject: Your listing is live on KiddBusy!
<p>Hi {submitter_name},</p><p>Great news — <strong>{business_name}</strong> is now live on KiddBusy.com! Families in {city} can now find you when they're looking for fun things to do with their kids.</p><p>Want to stand out even more? Our sponsorship options put your business at the top of search results:</p><ul><li><strong>Sponsored Listing</strong> — $49/month</li><li><strong>Banner Ad</strong> — $199/month</li><li><strong>Bundle</strong> — $219/month (best value!)</li></ul><p>Interested? Just reply to this email!</p><p>Warmly,<br>The KiddBusy Team</p>

SUBMISSION APPROVED (is_owner = false):
Subject: The listing you submitted is live on KiddBusy!
<p>Hi {submitter_name},</p><p>Thanks to you, <strong>{business_name}</strong> is now live on KiddBusy.com! Families in {city} can find it when looking for fun things to do with their kids.</p><p>We love having community members like you help build the directory — thank you!</p><p>Warmly,<br>The KiddBusy Team</p>

SUBMISSION REJECTED (missing info):
Subject: A note about your KiddBusy submission
<p>Hi {submitter_name},</p><p>Thank you for submitting <strong>{business_name}</strong>! We need a bit more information: {missing_fields}. Please reply and we'll get your listing up right away!</p><p>Warmly,<br>The KiddBusy Team</p>

SUBMISSION REJECTED (duplicate):
Subject: A note about your KiddBusy submission
<p>Hi {submitter_name},</p><p>It looks like <strong>{business_name}</strong> may already have a listing on our site. Reply if you'd like to claim or update it!</p><p>Warmly,<br>The KiddBusy Team</p>

REVIEW APPROVED:
Subject: Your KiddBusy review is live!
<p>Hi {reviewer_name},</p><p>Your review of <strong>{business_name}</strong> is now live on KiddBusy! Thank you for helping other families find great places to go.</p><p>Warmly,<br>The KiddBusy Team</p>

REVIEW REJECTED:
Subject: About your recent KiddBusy review
<p>Hi {reviewer_name},</p><p>We weren't able to publish your review as it didn't meet our community guidelines. We welcome honest, helpful reviews focused on the family experience. Feel free to resubmit!</p><p>Warmly,<br>The KiddBusy Team</p>

SPONSORSHIP INQUIRY RECEIVED:
Subject: Thanks for your interest in sponsoring KiddBusy!
<p>Hi {first_name},</p><p>Thank you for reaching out about sponsoring <strong>{business_name}</strong> on KiddBusy! We'll be in touch within 1 business day to discuss next steps.</p><p>Quick overview: Sponsored Listing ($49/mo), Banner Ad ($199/mo), Bundle ($219/mo).</p><p>Warmly,<br>The KiddBusy Team</p>

DAILY SUMMARY (to admin@kiddbusy.com):
Subject: KiddBusy Daily Agent Report — {date}
List everything you did: submissions approved/rejected, reviews processed, sponsorship emails sent, any issues encountered.

RULES:
- Be thorough — process everything pending, don't skip items
- Always send the right email after each action
- If something is ambiguous, use your best judgment and note it in the daily summary
- Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

  let messages = [{ role: 'user', content: task }];
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    log(`\n[iteration ${iterations}]`);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Anthropic API error: ${err.error?.message || JSON.stringify(err)}`);
    }

    const response = await res.json();
    log(`  stop_reason: ${response.stop_reason}`);

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse.name, toolUse.input, log);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

    } else {
      // end_turn — agent is done
      const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      log(`\n[agent complete]\n${finalText}`);
      return finalText;
    }
  }

  throw new Error('Agent exceeded max iterations');
}

// ---- NETLIFY HANDLER ----
exports.handler = async (event) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  log(`[KiddBusy Autonomous Agent] Starting at ${new Date().toISOString()}`);

  // Allow manual trigger via HTTP for testing
  const isManual = event.httpMethod === 'POST' || event.httpMethod === 'GET';
  if (isManual && event.headers['x-agent-key'] !== process.env.AGENT_SECRET_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const task = `Run the daily KiddBusy agent routine. Check all pending submissions, reviews, and sponsorships. Process them appropriately, send the right emails, and send me a daily summary to admin@kiddbusy.com when done.`;

    const summary = await runAgent(task, log);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, summary, log: logs })
    };

  } catch (err) {
    log(`[ERROR] ${err.message}`);
    // Try to send an error alert
    try {
      await sendEmail(
        'admin@kiddbusy.com',
        'KiddBusy Agent Error',
        `<p>The daily KiddBusy agent encountered an error:</p><pre>${err.message}</pre><p>Please check the Netlify function logs.</p>`,
        'KiddBusy Agent'
      );
    } catch {}

    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, log: logs })
    };
  }
};
