
// ----------------------------------------
const ADMIN_PASSWORD = 'kiddbusy2024'; // Change this
const SUPABASE_URL = 'https://wgbdwpbexfcxijcrxyii.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnYmR3cGJleGZjeGlqY3J4eWlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDE0NzIxMzQsImV4cCI6MjA1NzA0ODEzNH0.jxU_St7aGHNFkCGzMiTqxJOXXpkPFj1qvHjEr7oNrM8';
const ANTHROPIC_API_URL = '/.netlify/functions/agent-proxy';

// ----------------------------------------
let conversationHistory = [];
let isLoading = false;
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ----------------------------------------
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

// ----------------------------------------
const tools = [
  {
    name: "query_submissions",
    description: "Get all location submissions from the database. Returns business name, type, city, status, submitter info, and submission date.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: 'pending', 'approved', 'rejected', or 'all'", enum: ["pending", "approved", "rejected", "all"] },
        limit: { type: "number", description: "Max records to return (default 50)" }
      },
      required: []
    }
  },
  {
    name: "query_reviews",
    description: "Get reviews from the database. Returns reviewer name, rating, review text, listing info, and status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: 'pending', 'approved', 'rejected', or 'all'" },
        limit: { type: "number", description: "Max records to return (default 50)" }
      },
      required: []
    }
  },
  {
    name: "query_sponsorships",
    description: "Get sponsorship inquiries and active sponsors from the database. Returns business name, plan, contact info, and status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: 'pending', 'active', 'cancelled', or 'all'" },
        limit: { type: "number", description: "Max records to return (default 50)" }
      },
      required: []
    }
  },
  {
    name: "query_listings",
    description: "Get approved business listings from the database. Returns name, category, city, rating, and review count.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "Filter by city name" },
        category: { type: "string", description: "Filter by business category/type" },
        limit: { type: "number", description: "Max records to return (default 50)" }
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
        id: { type: "string", description: "The submission UUID" },
        status: { type: "string", description: "New status: 'approved' or 'rejected'", enum: ["approved", "rejected"] },
        reason: { type: "string", description: "Optional reason for the decision" }
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
        id: { type: "string", description: "The review UUID" },
        status: { type: "string", description: "New status: 'approved' or 'rejected'", enum: ["approved", "rejected"] }
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
    description: "Update an agent directive/configuration value.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The directive key" },
        value: { type: "string", description: "The new value" }
      },
      required: ["key", "value"]
    }
  }
];

// ----------------------------------------
async function executeTool(name, input) {
  try {
    switch (name) {
      case 'query_submissions': {
        let q = supabase.from('submissions').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.status && input.status !== 'all') q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, submissions: data };
      }
      case 'query_reviews': {
        let q = supabase.from('reviews').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.status && input.status !== 'all') q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, reviews: data };
      }
      case 'query_sponsorships': {
        let q = supabase.from('sponsorships').select('*').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.status && input.status !== 'all') q = q.eq('status', input.status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, sponsorships: data };
      }
      case 'query_listings': {
        let q = supabase.from('listings').select('id, name, type, city, address, url, avg_rating, review_count, created_at').order('created_at', { ascending: false }).limit(input.limit || 50);
        if (input.city) q = q.ilike('city', `%${input.city}%`);
        if (input.category) q = q.ilike('type', `%${input.category}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { count: data.length, listings: data };
      }
      case 'update_submission_status': {
        const { error } = await supabase.from('submissions').update({ status: input.status }).eq('id', input.id);
        if (error) return { error: error.message };
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'update_review_status': {
        const { error } = await supabase.from('reviews').update({ status: input.status }).eq('id', input.id);
        if (error) return { error: error.message };
        return { success: true, id: input.id, new_status: input.status };
      }
      case 'get_directives': {
        const { data, error } = await supabase.from('directives').select('*');
        if (error) return { note: 'directives table not yet created', defaults: { auto_approve: false, follow_up_days: 2 } };
        return { directives: Object.fromEntries((data || []).map(d => [d.key, d.value])) };
      }
      case 'update_directive': {
        const { error } = await supabase.from('directives').upsert({ key: input.key, value: input.value, updated_at: new Date().toISOString() });
        if (error) return { error: error.message };
        return { success: true, key: input.key, value: input.value };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ----------------------------------------
async function callAgent(messages) {
  const systemPrompt = `You are the KiddBusy business agent - an autonomous AI manager for KiddBusy.com, a family activity directory.

You have direct access to the KiddBusy database through tools. Use them proactively to answer questions with real data.

Your capabilities:
- Query and analyze all business data (submissions, reviews, sponsorships, listings)
- Approve or reject submissions and reviews  
- Read and update agent directives
- Provide strategic business analysis and recommendations

Business context:
- KiddBusy.com is a directory of kid-friendly activities and businesses
- Revenue comes from sponsorships: Sponsored Listing ($49/mo), Banner Ad ($199/mo), Bundle ($219/mo)
- Submissions go through review before being listed
- Reviews are moderated before publishing

When asked for analysis, always pull real data first using the tools, then reason about it.
Be direct, specific, and actionable. Format responses clearly with headers and tables where helpful.
When you take actions (like approving submissions), confirm what you did.
Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

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

// ----------------------------------------
async function runAgentLoop(userMessage) {
  const messagesEl = document.getElementById('messages');
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.remove();

  // Add user message to UI
  appendMessage('user', userMessage);

  // Add to history
  conversationHistory.push({ role: 'user', content: userMessage });

  // Show typing
  const typingEl = appendTyping();
  isLoading = true;
  document.getElementById('send-btn').disabled = true;

  try {
    let currentMessages = [...conversationHistory];

    while (true) {
      const response = await callAgent(currentMessages);

      // Handle tool use
      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(b => b.type === 'tool_use');
        const textBlocks = response.content.filter(b => b.type === 'text');

        // Show any text before tool use
        if (textBlocks.length > 0) {
          const text = textBlocks.map(b => b.text).join('\n');
          if (text.trim()) updateTyping(typingEl, text);
        }

        // Show tool indicators
        for (const toolUse of toolUses) {
          appendToolIndicator(toolUse.name);
        }

        // Execute tools
        const toolResults = [];
        for (const toolUse of toolUses) {
          const result = await executeTool(toolUse.name, toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
        }

        // Add assistant response and tool results to history
        currentMessages.push({ role: 'assistant', content: response.content });
        currentMessages.push({ role: 'user', content: toolResults });

      } else {
        // Final response
        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        typingEl.remove();
        appendMessage('agent', text);
        conversationHistory.push({ role: 'assistant', content: response.content });
        break;
      }
    }
  } catch (err) {
    typingEl.remove();
    appendMessage('agent', `(!) Error: ${err.message}\n\nMake sure your Anthropic API key is configured in the Netlify environment variables as \`ANTHROPIC_API_KEY\`, or this page needs a proxy function.`);
  }

  isLoading = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('user-input').focus();
}

// ----------------------------------------
function appendMessage(role, text) {
  const messagesEl = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;

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
  div.innerHTML = `<div class="msg-meta">AGENT</div><div class="typing"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function updateTyping(el, text) {
  el.querySelector('.typing').outerHTML = `<div class="msg-bubble">${formatMessage(text)}</div>`;
}

function appendToolIndicator(toolName) {
  const messagesEl = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = `<div class="tool-indicator">running ${toolName.replace(/_/g,' ')}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatMessage(text) {
  // Basic markdown-like formatting
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(.+)$/, '<p>$1</p>');
}

function clearChat() {
  conversationHistory = [];
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = `<div class="empty-state" id="empty-state">
    <div class="big-label">KiddBusy Agent</div>
    <div class="tagline">Your autonomous business manager. Ask me anything about your listings, reviews, sponsors, or strategy - I have direct access to your data.</div>
  </div>`;
}

// ----------------------------------------
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
