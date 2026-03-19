// netlify/functions/telegram-webhook.js
// Receives Telegram messages and routes them to the shared President-agent stack.

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const { runAgentConversation } = require('../lib/agent-router-core');

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text || '').slice(0, 4000),
      parse_mode: 'HTML'
    })
  });
  const body = await res.text();
  let data = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch (_) {
    data = body;
  }
  if (!res.ok) {
    const message = data && data.description ? data.description : `Telegram HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

async function runTelegramAgent(userMessage) {
  const result = await runAgentConversation({
    role: 'president_agent',
    userMessage: String(userMessage || ''),
    history: [],
    channel: 'telegram',
    threadKey: `telegram:${TELEGRAM_ALLOWED_CHAT_ID || 'default'}`,
    ownerIdentity: 'harold'
  });
  const label = result && result.agent_name ? `[${result.agent_name}] ` : '';
  return `${label}${result.reply || ''}`.trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'OK' };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 200, body: 'OK' };
  }

  const message = body && body.message;
  if (!message || !message.chat) {
    return { statusCode: 200, body: 'OK' };
  }

  const chatId = String(message.chat.id || '');
  const text = String(message.text || message.caption || '').trim();
  if (!chatId || !text) {
    return { statusCode: 200, body: 'OK' };
  }

  if (TELEGRAM_ALLOWED_CHAT_ID && chatId !== TELEGRAM_ALLOWED_CHAT_ID) {
    try {
      await sendTelegram(chatId, 'Unauthorized.');
    } catch (_) {
      // Ignore outbound Telegram failures for unauthorized callers.
    }
    return { statusCode: 200, body: 'OK' };
  }

  try {
    await sendTelegram(chatId, 'On it...');
    const reply = await runTelegramAgent(text);
    await sendTelegram(chatId, reply || 'No response generated.');
  } catch (err) {
    try {
      await sendTelegram(chatId, `Error: ${err.message || 'unknown error'}`);
    } catch (_) {
      // If Telegram send fails too, just return 200 to stop webhook retries.
    }
  }

  return { statusCode: 200, body: 'OK' };
};
