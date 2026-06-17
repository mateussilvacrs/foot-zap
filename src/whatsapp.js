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
  if (!response.ok) throw new Error(`Evolution API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function sendPoll(number, name, optionsArray) {
  const { instance } = requiredConfig();
  const payload = { number, name, selectableCount: 1, values: optionsArray };
  try {
    return await postEvolution(`/messages/sendPoll/${instance || ''}`, payload);
  } catch (error) {
    if (String(error.message).includes('404')) return await postEvolution(`/message/sendPoll/${instance || ''}`, payload);
    throw error;
  }
}

async function sendText(number, text) {
  const { instance } = requiredConfig();
  const payload = { number, text, options: { delay: 800, presence: 'composing' } };
  try {
    return await postEvolution(`/messages/sendText/${instance || ''}`, payload);
  } catch (error) {
    if (String(error.message).includes('404')) return postEvolution(`/message/sendText/${instance || ''}`, payload);
    throw error;
  }
}

function sendGroupMessage(text) { return sendText(process.env.WHATSAPP_GROUP_ID, text); }

function extractWebhookMessage(body = {}) {
  const payload = body.data || body;
  const message = payload.message || payload.messages?.[0] || payload;
  const key = message.key || payload.key || {};
  const remoteJid = key.remoteJid || message.remoteJid || payload.remoteJid || '';
  
  let senderJid = key.participant || message.participant || payload.participant || remoteJid;
  const altJid = key.participantAlt || message.participantAlt || payload.participantAlt;

  // Prioriza o altJid que contém o telefone correto
  if (altJid && altJid.includes('@s.whatsapp.net')) senderJid = altJid;
  else if (senderJid && senderJid.includes('@lid') && altJid) senderJid = altJid;

  return {
    text: (message.message?.conversation || message.conversation || message.text || '').trim(),
    telefone: onlyDigits(senderJid.split('@')[0]),
    remoteJid,
    isGroup: remoteJid.endsWith('@g.us'),
    fromMe: Boolean(key.fromMe || message.fromMe)
  };
}

module.exports = { sendText, sendGroupMessage, sendPoll, extractWebhookMessage };