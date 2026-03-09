// CONFIG
const ADMIN_PASSWORD = 'kiddbusy2024';
const SUPABASE_URL = 'https://wgbdwpbexfcxijcrxyii.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indnd2V4enlxYWl3b3NncmFhY3ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2ODEwNzUsImV4cCI6MjA4ODI1NzA3NX0.IS8u4SL1XeLh9KgD4c2Pl9BiGNg0zkiNauUzu_QtKH8';
const ANTHROPIC_API_URL = '/.netlify/functions/agent-proxy';

// STATE
let conversationHistory = [];
let isLoading = false;
let _supabase = null;
function getSupabase() {
  if (!_supabase) _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

// AUTH
function checkLogin() {
  const pass = document.getElementById('pass-input').value;
  if (pass === ADMIN_PASSWORD) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('user-input').focus();
  } else {
    document.getElementById('login-error').style.display = 'block';
    document.getElementById('pass-input').value = '';
  }
}

document.getElementById('pass-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') checkLogin();
});

// TOOLS
const tools = [
  {
    name: "query_submissions",
    description: "Get all location submissions from the database.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected", "all"] },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "query_reviews",
    description: "Get reviews from the database.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "query_sponsorships",
    description: "Get sponsorship inquiries and active sponsors.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "query_listings",
    description: "Get approved business listings.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        category: { type: "string" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "update_submission_status",
    description: "Approve or reject a submission by ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["approved", "rejected"] },
        reason: { type: "string" }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "update_review_status",
    description: "Approve or reject a review by ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["approved", "rejected"] }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "update_sponsorship_status",
    description: "Update a sponsorship status by ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["active", "cancelled", "pending"] }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "get_directives",
    description: "Read the current agent directives and configuration.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "update_directive",
    description: "Update an agent directive.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "send_email",
    description: "Send an email via Resend. Use for welcoming sponsors, notifying submitters of decisions, following up with leads, or any business communication.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body - plain text or HTML" },
        from_name: { type: "string", description: "Sender display name (default: KiddBusy)" }
      },
      required: ["to", "subject", "body"]
    }
  }
];

// TOOL EXECUTION
async function executeTool(name, input) {
  try {
    switch (name) {
      case 'query_submissions': {
        let q = getSupabase().from('submissions').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.status && input.status !== 'all') q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, submissions: data };
      }
      case 'query_reviews': {
        let q = getSupabase().from('reviews').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.status && input.status !== 'all') q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, reviews: data };
      }
      case 'query_sponsorships': {
        let q = getSupabase().from('sponsorships').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.status && input.status !== 'all') q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, sponsorships: data };
      }
      case 'query_listings': {
        let q = getSupabase().from('listings').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.city) q = q.ilike('city', '%' + input.city + '%');
        if (input.category) q = q.ilike('type', '%' + input.category + '%');
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, listings: data };
      }
      case 'update_submission_status': {
        const { error } = await getSupabase().from('submissions').update({ status: input.status }).eq('id', input.id);
        if (error) return { error: error.message };
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_review_status': {
        const { error } = await getSupabase().from('reviews').update({ status: input.status }).eq('id', input.id);
        if (error) return { error: error.message };
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_sponsorship_status': {
        const { error } = await getSupabase().from('sponsorships').update({ status: input.status }).eq('id', input.id);
        if (error) return { error: error.message };
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'get_directives': {
        const { data, error } = await getSupabase().from('directives').select('*');
        if (error) return { note: 'directives table not yet created', defaults: { auto_approve: false, follow_up_days: 2 } };
        return { directives: Object.fromEntries((data || []).map(d => [d.key, d.value])) };
      }
      case 'update_directive': {
        const { error } = await getSupabase().from('directives').upsert({ key: input.key, value: input.value, updated_at: new Date().toISOString() });
        if (error) return { error: error.message };
        return { success: true, key: input.key, value: input.value };
      }
      case 'send_email': {
        const response = await fetch('/.netlify/functions/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-From': 'kiddbusy-agent' },
          body: JSON.stringify({
            to: input.to,
            subject: input.subject,
            body: input.body,
            from_name: input.from_name || 'KiddBusy'
          })
        });
        const result = await response.json();
        if (!response.ok) return { error: result.error || 'Email send failed' };
        return { success: true, to: input.to, subject: input.subject };
      }
      default:
        return { error: 'Unknown tool: ' + name };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// AGENT API CALL
async function callAgent(messages) {
  const systemPrompt = `You are the KiddBusy business agent - an autonomous AI manager for KiddBusy.com, a family activity directory serving parents looking for kid-friendly activities and businesses.

You have direct access to the KiddBusy database and can send emails. Use your tools proactively.

CAPABILITIES:
- Query and analyze all data (submissions, reviews, sponsorships, listings)
- Approve or reject submissions and reviews
- Update sponsorship statuses
- Send emails from admin@kiddbusy.com
- Read and update agent directives

BUSINESS CONTEXT:
- KiddBusy.com lists kid-friendly activities and businesses
- Sponsorship plans: Sponsored Listing ($49/mo), Banner Ad ($199/mo), Bundle ($219/mo)
- Submissions are reviewed before listing; reviews are moderated before publishing
- Brand voice: warm, friendly, family-focused

EMAIL GUIDELINES:
- Always send from: admin@kiddbusy.com
- Tone: warm and friendly, like a helpful neighbor who knows the best spots for families
- Sign off as: The KiddBusy Team
- Use the templates below as your base — personalize with the business name, city, and any relevant details
- Send HTML emails for richer formatting

EMAIL TEMPLATES:

--- TEMPLATE 1: Submission Received ---
Subject: We got your submission, {business_name}!
Body:
<p>Hi {submitter_name},</p>
<p>Thanks so much for submitting <strong>{business_name}</strong> to KiddBusy! We're thrilled you want to be part of our community of kid-friendly businesses in {city}.</p>
<p>Our team will review your listing within 2-3 business days. We'll be in touch once it's live!</p>
<p>In the meantime, if you have any questions, just reply to this email.</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 2A: Submission Approved (is_owner = true) ---
Subject: Your listing is live on KiddBusy!
Body:
<p>Hi {submitter_name},</p>
<p>Great news — <strong>{business_name}</strong> is now live on KiddBusy.com! Families in {city} can now find you when they're looking for fun things to do with their kids.</p>
<p>Want to stand out even more? Our sponsorship options put your business at the top of search results and in front of even more local families:</p>
<ul>
<li><strong>Sponsored Listing</strong> — $49/month: Featured placement in your category</li>
<li><strong>Banner Ad</strong> — $199/month: Prime banner visibility across the site</li>
<li><strong>Bundle</strong> — $219/month: Sponsored listing + banner ad (best value!)</li>
</ul>
<p>Interested? Just reply to this email and we'll get you set up!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 2B: Submission Approved (is_owner = false — community submission) ---
Subject: The listing you submitted is live on KiddBusy!
Body:
<p>Hi {submitter_name},</p>
<p>Thanks to you, <strong>{business_name}</strong> is now live on KiddBusy.com! Families in {city} can find it when they're looking for fun things to do with their kids.</p>
<p>We love having community members like you help build the directory — thank you for spreading the word about great local spots!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 3: Submission Rejected - Missing Information ---
Subject: A note about your KiddBusy submission
Body:
<p>Hi {submitter_name},</p>
<p>Thank you for submitting <strong>{business_name}</strong> to KiddBusy! We weren't able to approve the listing just yet — we need a little more information to complete your profile.</p>
<p>Could you reply with the following?</p>
<ul>
<li>{missing_fields}</li>
</ul>
<p>Once we have everything, we'll get your listing up right away. We'd love to have you on the site!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 4: Submission Rejected - Duplicate ---
Subject: A note about your KiddBusy submission
Body:
<p>Hi {submitter_name},</p>
<p>Thank you for thinking of KiddBusy! It looks like <strong>{business_name}</strong> may already have a listing on our site.</p>
<p>If you'd like to claim or update an existing listing, or if you think this was an error, just reply to this email and we'll sort it out together.</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 5: Review Approved ---
Subject: Your KiddBusy review is live!
Body:
<p>Hi {reviewer_name},</p>
<p>Thanks for sharing your experience — your review of <strong>{business_name}</strong> is now live on KiddBusy! Reviews like yours help other families in {city} find great places to go with their kids.</p>
<p>Keep exploring and let us know about other great spots!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 6: Review Rejected ---
Subject: About your recent KiddBusy review
Body:
<p>Hi {reviewer_name},</p>
<p>Thank you for taking the time to leave a review on KiddBusy. Unfortunately, we weren't able to publish it as submitted — it didn't quite meet our community guidelines.</p>
<p>We welcome honest, helpful reviews that focus on the experience families can expect. If you'd like to resubmit, we'd love to hear from you!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 7: Sponsorship Inquiry Received ---
Subject: Thanks for your interest in sponsoring KiddBusy!
Body:
<p>Hi {first_name},</p>
<p>Thank you for reaching out about sponsoring <strong>{business_name}</strong> on KiddBusy! We're excited about the possibility of featuring you more prominently to local families.</p>
<p>Here's a quick look at what we offer:</p>
<ul>
<li><strong>Sponsored Listing</strong> — $49/month: Featured placement at the top of your category</li>
<li><strong>Banner Ad</strong> — $199/month: High-visibility banner across the site</li>
<li><strong>Bundle</strong> — $219/month: Both options at a discount (most popular!)</li>
</ul>
<p>We'll be in touch within 1 business day to discuss next steps. Can't wait to help more families discover {business_name}!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 8: Sponsorship Activated ---
Subject: Welcome to KiddBusy — your sponsorship is live!
Body:
<p>Hi {first_name},</p>
<p>You're officially a KiddBusy sponsor — welcome aboard! 🎉</p>
<p>Here's what's active for <strong>{business_name}</strong>:</p>
<ul>
<li><strong>Plan:</strong> {plan}</li>
<li><strong>Started:</strong> {start_date}</li>
<li><strong>Billing:</strong> {billing_cycle}</li>
</ul>
<p>Families in {city} are already seeing you. If you ever want to make changes to your listing, swap out a banner, or have any questions at all — just reply to this email.</p>
<p>So glad to have you with us!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 9: Sponsorship Payment Reminder ---
Subject: Just a heads up — your KiddBusy sponsorship renews soon
Body:
<p>Hi {first_name},</p>
<p>This is a friendly reminder that your <strong>{plan}</strong> sponsorship for <strong>{business_name}</strong> is coming up for renewal.</p>
<p>No action needed if everything looks good — we just wanted to give you a heads up. If you'd like to make any changes or have questions, just reply here.</p>
<p>Thanks for being part of the KiddBusy family!</p>
<p>Warmly,<br>The KiddBusy Team</p>

--- TEMPLATE 10: Sponsorship Cancelled ---
Subject: Your KiddBusy sponsorship has been cancelled
Body:
<p>Hi {first_name},</p>
<p>We've processed the cancellation of your <strong>{plan}</strong> sponsorship for <strong>{business_name}</strong>. We're sorry to see you go!</p>
<p>Your free listing will remain on KiddBusy so families can still find you. If you ever want to sponsor again — or if this was a mistake — just reply and we'll take care of it.</p>
<p>Wishing you all the best,<br>The KiddBusy Team</p>

--- TEMPLATE 10: Cold Lead Follow-Up ---
Subject: Is {business_name} still interested in KiddBusy?
Body:
<p>Hi {first_name},</p>
<p>I wanted to follow up on {business_name}'s listing on KiddBusy. We love having you in our directory, and I wanted to share that families in {city} are actively searching for businesses just like yours.</p>
<p>If you'd like to get even more visibility, our sponsorship options are a great way to stand out:</p>
<ul>
<li><strong>Sponsored Listing</strong> — $49/month</li>
<li><strong>Banner Ad</strong> — $199/month</li>
<li><strong>Bundle</strong> — $219/month (best value)</li>
</ul>
<p>No pressure at all — just wanted to make sure you knew the option was there. Happy to answer any questions!</p>
<p>Warmly,<br>The KiddBusy Team</p>

WHEN TO SEND EMAILS:
- After approving a submission: check is_owner field. If is_owner = true, send Template 2A (with sponsorship upsell). If is_owner = false, send Template 2B (thank you only, no upsell).
- After rejecting a submission: send Template 3 or 4 based on reason
- After approving a review: send Template 5 to reviewer_email
- After rejecting a review: send Template 6 to reviewer_email
- When a new sponsorship comes in (status=pending): send Template 7 to their email
- When activating a sponsorship: send Template 8 to their email
- When cancelling a sponsorship: send Template 10 (cancellation) to their email
- For follow-ups on approved listings that haven't sponsored: send Template 10 (cold lead)

Always personalize templates with real data from the database. If a field is unknown, omit that line gracefully.
Always pull real data before answering. Be direct and actionable. Confirm actions taken.
Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-From': 'kiddbusy-agent' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: tools,
      messages: messages
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'API error');
  }
  return await response.json();
}

// AGENTIC LOOP
async function runAgentLoop(userMessage) {
  const messagesEl = document.getElementById('messages');
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.remove();

  appendMessage('user', userMessage);
  conversationHistory.push({ role: 'user', content: userMessage });

  const typingEl = appendTyping();
  isLoading = true;
  document.getElementById('send-btn').disabled = true;

  try {
    let currentMessages = [...conversationHistory];

    while (true) {
      const response = await callAgent(currentMessages);

      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(b => b.type === 'tool_use');
        const textBlocks = response.content.filter(b => b.type === 'text');

        if (textBlocks.length > 0) {
          const text = textBlocks.map(b => b.text).join('\n');
          if (text.trim()) updateTyping(typingEl, text);
        }

        for (const toolUse of toolUses) {
          appendToolIndicator(toolUse.name);
        }

        const toolResults = [];
        for (const toolUse of toolUses) {
          const result = await executeTool(toolUse.name, toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
        }

        currentMessages.push({ role: 'assistant', content: response.content });
        currentMessages.push({ role: 'user', content: toolResults });

      } else {
        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        typingEl.remove();
        appendMessage('agent', text);
        conversationHistory.push({ role: 'assistant', content: response.content });
        break;
      }
    }
  } catch (err) {
    typingEl.remove();
    appendMessage('agent', '(!) Error: ' + err.message + '\n\nMake sure ANTHROPIC_API_KEY is set in Netlify environment variables.');
  }

  isLoading = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('user-input').focus();
}

// UI HELPERS
function appendMessage(role, text) {
  const messagesEl = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'user' ? 'YOU' : 'AGENT - ' + new Date().toLocaleTimeString();

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = formatMessage(text);

  div.appendChild(meta);
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendTyping() {
  const messagesEl = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = '<div class="msg-meta">AGENT</div><div class="typing"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function updateTyping(el, text) {
  const typing = el.querySelector('.typing');
  if (typing) typing.outerHTML = '<div class="msg-bubble">' + formatMessage(text) + '</div>';
}

function appendToolIndicator(toolName) {
  const messagesEl = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = '<div class="tool-indicator">running ' + toolName.replace(/_/g, ' ') + '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatMessage(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^#{1,3} (.+)$/gm, '<h3>$1</h3>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

function clearChat() {
  conversationHistory = [];
  document.getElementById('messages').innerHTML = '<div class="empty-state" id="empty-state"><div class="big-label">KiddBusy Agent</div><div class="tagline">Your autonomous business manager. Ask me anything about your listings, reviews, sponsors, or strategy - I have direct access to your data and can send emails.</div></div>';
}

function sendMessage() {
  const input = document.getElementById('user-input');
  const text = input.value.trim();
  if (!text || isLoading) return;
  input.value = '';
  input.style.height = 'auto';
  runAgentLoop(text);
}

function sendQuick(text) {
  if (isLoading) return;
  runAgentLoop(text);
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
