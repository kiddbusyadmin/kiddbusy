// CONFIG
const ADMIN_PASSWORD = 'kiddbusy2024';
const SUPABASE_URL = 'https://wgbdwpbexfcxijcrxyii.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnYmR3cGJleGZjeGlqY3J4eWlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDE0NzIxMzQsImV4cCI6MjA1NzA0ODEzNH0.jxU_St7aGHNFkCGzMiTqxJOXXpkPFj1qvHjEr7oNrM8';
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
  const systemPrompt = `You are the KiddBusy business agent - an autonomous AI manager for KiddBusy.com, a family activity directory.

You have direct access to the KiddBusy database and can send emails. Use your tools proactively.

Capabilities:
- Query and analyze all data (submissions, reviews, sponsorships, listings)
- Approve or reject submissions and reviews
- Update sponsorship statuses
- Send emails to submitters, sponsors, and leads (always from admin@kiddbusy.com)
- Read and update agent directives

Business context:
- KiddBusy.com lists kid-friendly activities and businesses
- Revenue: Sponsored Listing ($49/mo), Banner Ad ($199/mo), Bundle ($219/mo)
- Submissions are reviewed before listing; reviews are moderated before publishing

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
