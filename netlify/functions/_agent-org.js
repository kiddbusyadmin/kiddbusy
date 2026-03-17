const { sbFetch } = require('./_accounting-core');
const { logAgentActivity } = require('./_agent-activity');

const DIRECTIVE_KEY = 'agent_registry_v1';
const REGISTRY_AGENT_KEY = 'agent_registry';

function defaultRegistry() {
  return {
    default_role: 'president_agent',
    version: 1,
    agents: [
      {
        key: 'president_agent',
        name: 'President',
        role: 'executive',
        report_to: null,
        direct_access: true,
        system_prompt: 'You are the President of KiddBusy. You coordinate specialists, prioritize traffic growth first, and synthesize plain-English recommendations for the owner.',
        description: 'Executive manager for the whole business. Default point of contact.',
        specialist_focus: ['strategy', 'delegation', 'synthesis', 'exceptions']
      },
      {
        key: 'operations_agent',
        name: 'Operations',
        role: 'operations',
        report_to: 'president_agent',
        direct_access: true,
        system_prompt: 'You run site operations for KiddBusy: listings, reviews, events, moderation, and workflow reliability.',
        description: 'Handles listings, reviews, submissions, events, moderation, and site health.',
        specialist_focus: ['listings', 'reviews', 'events', 'moderation', 'workflow']
      },
      {
        key: 'cmo_agent',
        name: 'CMO',
        role: 'marketing',
        report_to: 'president_agent',
        direct_access: true,
        system_prompt: 'You are the CMO of KiddBusy. Your mission is organic traffic growth, SEO, content, outreach, and conversion lift.',
        description: 'Owns traffic, SEO, blog, messaging, outreach, and growth experiments.',
        specialist_focus: ['traffic', 'seo', 'blog', 'email', 'conversion']
      },
      {
        key: 'accountant_agent',
        name: 'Accountant',
        role: 'finance',
        report_to: 'president_agent',
        direct_access: true,
        system_prompt: 'You are the Accountant of KiddBusy. You maintain revenue truth, expenses, P&L thinking, and financial guardrails.',
        description: 'Owns finance snapshots, spend tracking, projections, and sponsor revenue accuracy.',
        specialist_focus: ['finance', 'pnl', 'costs', 'revenue', 'forecasting']
      }
    ]
  };
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function sanitizeAgent(input) {
  const key = normalizeKey(input && (input.key || input.name));
  if (!key) throw new Error('Agent key is required');
  const name = String((input && input.name) || key).trim().slice(0, 80);
  const description = String((input && input.description) || '').trim().slice(0, 500);
  const systemPrompt = String((input && input.system_prompt) || '').trim().slice(0, 3000);
  const explicitReportTo = input && Object.prototype.hasOwnProperty.call(input, 'report_to') ? input.report_to : undefined;
  const reportTo = key === 'president_agent'
    ? null
    : (explicitReportTo === null ? null : (normalizeKey(explicitReportTo) || 'president_agent'));
  return {
    key,
    name,
    role: normalizeKey(input && input.role) || 'specialist',
    report_to: reportTo,
    direct_access: input && Object.prototype.hasOwnProperty.call(input, 'direct_access') ? !!input.direct_access : true,
    description,
    system_prompt: systemPrompt || `You are ${name}, a KiddBusy specialist agent. ${description || 'Help the business in your domain and report clearly to the President.'}`,
    specialist_focus: Array.isArray(input && input.specialist_focus)
      ? input.specialist_focus.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 12)
      : []
  };
}

function mergeRegistry(raw) {
  const base = defaultRegistry();
  if (!raw || typeof raw !== 'object') return base;
  const custom = Array.isArray(raw.agents) ? raw.agents.map((a) => sanitizeAgent(a)).filter(Boolean) : [];
  const byKey = new Map(base.agents.map((a) => [a.key, a]));
  for (const agent of custom) byKey.set(agent.key, Object.assign({}, byKey.get(agent.key) || {}, agent));
  return {
    version: Number(raw.version) || base.version,
    default_role: normalizeKey(raw.default_role) || base.default_role,
    agents: Array.from(byKey.values())
  };
}

async function readDirectiveRegistry() {
  try {
    const { response, data } = await sbFetch(`directives?key=eq.${encodeURIComponent(DIRECTIVE_KEY)}&select=key,value&limit=1`);
    if (!response.ok || !Array.isArray(data) || !data.length) return null;
    const value = data[0] && data[0].value;
    if (!value) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return null;
  }
}

async function writeDirectiveRegistry(registry) {
  try {
    const { response } = await sbFetch('directives?on_conflict=key', {
      method: 'POST',
      body: {
        key: DIRECTIVE_KEY,
        value: registry,
        updated_at: new Date().toISOString()
      },
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function readActivityRegistry() {
  try {
    const { response, data } = await sbFetch(`agent_activity?agent_key=eq.${encodeURIComponent(REGISTRY_AGENT_KEY)}&select=details,created_at&order=created_at.desc&limit=1`);
    if (!response.ok || !Array.isArray(data) || !data.length) return null;
    const details = data[0] && data[0].details;
    if (!details || typeof details !== 'object') return null;
    return details.registry || null;
  } catch (_) {
    return null;
  }
}

async function persistRegistry(registry, summary) {
  const savedToDirective = await writeDirectiveRegistry(registry);
  await logAgentActivity({
    agentKey: REGISTRY_AGENT_KEY,
    status: 'config',
    summary: summary || 'Agent registry updated.',
    details: { registry, saved_to_directive: savedToDirective }
  });
  return { ok: true, saved_to_directive: savedToDirective };
}

async function getAgentRegistry() {
  const directive = await readDirectiveRegistry();
  if (directive) return mergeRegistry(directive);
  const activity = await readActivityRegistry();
  if (activity) return mergeRegistry(activity);
  return defaultRegistry();
}

async function createAgentDefinition(input) {
  const registry = await getAgentRegistry();
  const agent = sanitizeAgent(input);
  if (registry.agents.some((a) => a.key === agent.key)) {
    throw new Error(`Agent ${agent.key} already exists`);
  }
  registry.agents.push(agent);
  await persistRegistry(registry, `Custom agent created: ${agent.name} (${agent.key}).`);
  return { registry, agent };
}

async function updateDefaultRole(role) {
  const registry = await getAgentRegistry();
  const safe = normalizeKey(role);
  if (!registry.agents.some((a) => a.key === safe)) throw new Error('Unknown agent role');
  registry.default_role = safe;
  await persistRegistry(registry, `Default agent updated to ${safe}.`);
  return registry;
}

function findAgent(registry, role) {
  const safe = normalizeKey(role) || normalizeKey(registry && registry.default_role);
  const agents = registry && Array.isArray(registry.agents) ? registry.agents : [];
  return agents.find((a) => a.key === safe) || agents.find((a) => a.key === 'president_agent') || agents[0] || null;
}

module.exports = {
  defaultRegistry,
  getAgentRegistry,
  createAgentDefinition,
  updateDefaultRole,
  findAgent,
  normalizeKey,
  sanitizeAgent
};
