// Autonomous KiddBusy Agent - runs on a schedule
// Uses fetch only — no npm dependencies required

const SUPABASE_URL = process.env.KB_DB_URL || 'https://wgwexzyqaiwosgraaczi.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ---- SUPABASE via REST ----
async function dbQuery(table, params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=*&imit=100`;
  if (params.eq) {
    for (const [col, val] of Object.entries(params.eq)) {
      url += `&${col}=eq.${encodeURIComponent(val)}`;
    }
  }
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (fetchErr) {
    throw new Error(`DB fetch network error on ${table}: ${fetchErr.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`DB query failed on ${table} (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function dbUpdate(table, id, updates) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(updates)
    });
  } catch (fetchErr) {
    throw new Error(`DB update network error on ${table}: ${fetchErr.message}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB update failed on ${table} (${res.status}): ${text}`);
  }
  return { success: true };
}

// ---- EMAIL via Resend ----
async function sendEmail(to, subject, body, fromName = 'KiddBusy') {
  const isHtml = body.trim().startsWith('<');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
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
async function executeTool(name, input, log) {
  log(`  [tool] ${name}(${JSON.stringify(input)})`);
  try {
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
      case 'update_submission_status': {
        await dbUpdate('submissions', input.id, { status: input.status });
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_review_status': {
        await dbUpdate('reviews', input.id, { status: input.status });
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_sponsorship_status': {
        await dbUpdate('sponsorships', input.id, { status: input.status });
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'get_directives': {
        try {
          const data = await dbQuery('directives');
          return { directives: Object.fromEntries(data.map(d => [d.key, d.value])) };
        } catch {
          return { note: 'directives table not yet created', defaults: {} };
        }
      }
      case 'send_email': {
        await sendEmail(input.to, input.subject, input.body, input.from_name || 'KiddBusy');
        return { success: true, to: input.to, subject: input.subject };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    log(`  [tool error] ${e.message}`);
    return { error: e.message };
  }
}

// ---- CLAUDE AGENTIC LOOP ----
async function runAgent(log) {
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
      description: 'Get agent directives/config.',
      input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'send_email',
      description: 'Send an email from admin@kiddbusy.com.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          from_name: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  ];

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const systemPrompt = `You are the autonomous KiddBusy business agent. You run every morning to keep the business running smoothly.

Your tasks today:
1. Query all pending submissions — approve legitimate kid-friendly businesses with enough info, reject duplicates or those missing info
2. Query all pending reviews — approve genuine helpful ones, reject spam or inappropriate ones
3. Query pending sponsorships — send inquiry received email to any new ones not yet contacted
4. Send a daily summary email to admin@kiddbusy.com with everything you did

EMAIL TEMPLATES — personalize with real data from the database:

SUBMISSION APPROVED (is_owner = true):
Subject: Your listing is live on KiddBusy!
<p>Hi {submitter_name},</p><p>Great news — <strong>{business_name}</strong> is now live on KiddBusy.com! Families in {city} can now find you when looking for fun things to do with their kids.</p><p>Want to stand out even more? Our sponsorship options put your business at the top of search results:</p><ul><li><strong>Sponsored Listing</strong> — $49/month</li><li><strong>Banner Ad</strong> — $199/month</li><li><strong>Bundle</strong> — $219/month (best value!)</li></ul><p>Interested? Just reply to this email!</p><p>Warmly,<br>The KiddBusy Team</p>

SUBMISSION APPROVED (is_owner = false):
Subject: The listing you submitted is live on KiddBusy!
<p>Hi {submitter_name},</p><p>Thanks to you, <strong>{business_name}</strong> is now live on KiddBusy.com! Families in {city} can find it when looking for fun things to do with their kids.</p><p>We love having community members like you help build the directory — thank you!</p><p>Warmly,<br>The KiddBusy Team</p>

SUBMISSION REJECTED (missing info):
Subject: A note about your KiddBusy submission
<p>Hi {submitter_name},</p><p>Thank you for submitting <strong>{business_name}</strong>! We need a bit more information to complete your profile: {missing_fields}. Please reply and we'll get your listing up right away!</p><p>Warmly,<br>The KiddBusy Team</p>

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
<p>Hi {first_name},</p><p>Thank you for reaching out about sponsoring <strong>{business_name}</strong> on KiddBusy! We'll be in touch within 1 business day.</p><p>Quick overview: Sponsored Listing ($49/mo), Banner Ad ($199/mo), Bundle ($219/mo).</p><p>Warmly,<br>The KiddBusy Team</p>

DAILY SUMMARY (always send this last to admin@kiddbusy.com):
Subject: KiddBusy Daily Agent Report — ${today}
List everything processed: submissions approved/rejected with business names, reviews processed, sponsorship emails sent, and any issues encountered. Be specific.

RULES:
- Process everything pending — don't skip items
- Always send the correct email after each action
- Use good judgment on borderline cases and note them in the summary
- Today: ${today}`;

  let messages = [{
    role: 'user',
    content: 'Run the daily KiddBusy agent routine. Process all pending submissions, reviews, and sponsorships. Send the appropriate emails for each action. Finish with a daily summary to admin@kiddbusy.com.'
  }];

  let iterations = 0;
  const MAX_ITERATIONS = 25;

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
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

    } else {
      const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      log(`\n[agent done]\n${finalText}`);
      return finalText;
    }
  }

  throw new Error('Agent exceeded max iterations');
}

// ---- NETLIFY HANDLER ----
exports.handler = async (event) => {
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  log(`[KiddBusy Agent] Starting ${new Date().toISOString()}`);
  log(`[config] KB_DB_SERVICE_KEY=${SUPABASE_SERVICE_KEY ? "SET len=" + SUPABASE_SERVICE_KEY.length : "MISSING"}`);
  log(`[config] ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);
  log(`[config] RESEND_API_KEY=${RESEND_API_KEY ? "SET" : "MISSING"}`);

  // Quick Supabase connectivity test
  try {
    const testRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=id&limit=1`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const testText = await testRes.text();
    log(`[db-test] status=${testRes.status} body=${testText.substring(0, 150)}`);
  } catch (e) {
    log(`[db-test] FAILED: ${e.message}`);
  }

  try {
    const summary = await runAgent(log);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, summary, log: logs })
    };
  } catch (err) {
    log(`[ERROR] ${err.message}`);
    try {
      await sendEmail(
        'admin@kiddbusy.com',
        'KiddBusy Agent Error',
        `<p>The daily agent hit an error:</p><pre>${err.message}</pre><p>Check Netlify function logs for details.</p>`,
        'KiddBusy Agent'
      );
    } catch {}
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, log: logs })
    };
  }
};
