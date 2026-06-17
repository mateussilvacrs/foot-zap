const { onlyDigits } = require('./database');

function requiredConfig() {
  return {
    apiUrl: process.env.EVOLUTION_API_URL,
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE,
    groupId: process.env.WHATSAPP_GROUP_ID
  };
}

async function postEvolution(path, payload, method = 'POST') {
  const { apiUrl, apiKey } = requiredConfig();
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    method: method,
    headers: { 'Content-Type': 'application/json', apikey: apiKey, Authorization: `Bearer ${apiKey}` },
    body: payload ? JSON.stringify(payload) : null
  });
  if (!response.ok) throw new Error(`API Error: ${await response.text()}`);
  return response.json();
}

async function getPollStatus(messageId) {
  try {
    const { instance } = requiredConfig();
    const data = await postEvolution(`/message/find/${instance}?messageId=${messageId}`, null, 'GET');
    return data.message?.pollUpdateMessage || null;
  } catch (e) {
    console.error("Erro ao buscar status da enquete:", e.message);
    return null;
  }
}

async function sendPoll(number, name, optionsArray) {
  return postEvolution(`/messages/sendPoll/${process.env.EVOLUTION_INSTANCE || ''}`, { number, name, selectableCount: 1, values: optionsArray });
}

async function sendText(number, text) {
  return postEvolution(`/messages/sendText/${process.env.EVOLUTION_INSTANCE || ''}`, { number, text, options: { delay: 800 } });
}

function extractWebhookMessage(body = {}) {
  const payload = body.data || body;
  const message = payload.message || payload.messages?.[0] || payload;
  const key = message.key || payload.key || {};
  const realNumber = key.participantAlt || payload.participantAlt || key.participant || payload.participant || key.remoteJid || '';
  const telefone = onlyDigits(realNumber.split('@')[0]);

  return {
    text: (message.message?.conversation || message.conversation || message.text || '').trim(),
    telefone: telefone,
    remoteJid: key.remoteJid || '',
    isGroup: (key.remoteJid || '').endsWith('@g.us'),
    fromMe: Boolean(key.fromMe)
  };
}

module.exports = { sendText, sendPoll, extractWebhookMessage, getPollStatus };