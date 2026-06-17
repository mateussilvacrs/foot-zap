const { onlyDigits } = require('./database');

function requiredConfig() {
  return {
    apiUrl: process.env.EVOLUTION_API_URL,
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE,
    groupId: process.env.WHATSAPP_GROUP_ID
  };
}

async function postEvolution(path, payload) {
  const { apiUrl, apiKey } = requiredConfig();
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`API Error: ${await response.text()}`);
  return response.json();
}

async function sendPoll(number, name, optionsArray) {
  const { instance } = requiredConfig();
  return postEvolution(`/messages/sendPoll/${instance || ''}`, { number, name, selectableCount: 1, values: optionsArray });
}

async function sendText(number, text) {
  const { instance } = requiredConfig();
  return postEvolution(`/messages/sendText/${instance || ''}`, { number, text, options: { delay: 800 } });
}

function extractWebhookMessage(body = {}) {
  const payload = body.data || body;
  const message = payload.message || payload.messages?.[0] || payload;
  const key = message.key || payload.key || {};
  
  // A MÁGICA: O participantAlt é o número real. Vamos usar ele sempre que existir!
  const realNumber = key.participantAlt || payload.participantAlt;
  const senderJid = realNumber || key.participant || payload.participant || key.remoteJid || '';

  const telefone = onlyDigits(senderJid.split('@')[0]);

  return {
    text: (message.message?.conversation || message.conversation || message.text || '').trim(),
    telefone: telefone,
    remoteJid: key.remoteJid || '',
    isGroup: (key.remoteJid || '').endsWith('@g.us'),
    fromMe: Boolean(key.fromMe)
  };
}

module.exports = { sendText, sendPoll, extractWebhookMessage };