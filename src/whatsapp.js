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
  if (!apiUrl || !apiKey) {
    console.log('[whatsapp:dry-run]', path, payload);
    return { dryRun: true };
  }

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API ${response.status}: ${body}`);
  }

  return response.json().catch(() => ({ ok: true }));
}

async function sendText(number, text) {
  const { instance } = requiredConfig();
  if (!number) throw new Error('Destino do WhatsApp nao configurado.');

  const payload = {
    number,
    text,
    options: { delay: 800, presence: 'composing' }
  };

  try {
    return await postEvolution(`/messages/sendText/${instance || ''}`, payload);
  } catch (error) {
    if (String(error.message).includes('404')) {
      return postEvolution(`/message/sendText/${instance || ''}`, payload);
    }
    throw error;
  }
}

function sendGroupMessage(text) {
  return sendText(process.env.WHATSAPP_GROUP_ID, text);
}

function sendPrivateMessage(telefone, text) {
  return sendText(onlyDigits(telefone), text);
}

function extractWebhookMessage(body = {}) {
  const event = body.event || body.type || body.eventType;
  const payload = body.data || body;
  const message = payload.message || payload.messages?.[0] || payload;
  const key = message.key || payload.key || {};
  const remoteJid = key.remoteJid || message.remoteJid || payload.remoteJid || '';
  const fromMe = Boolean(key.fromMe || message.fromMe);
  const text =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.text ||
    message.body ||
    payload.text ||
    '';
    
  const pushName = message.pushName || payload.pushName || message.notifyName || '';
  
  // Extração do número com desvio do LID de privacidade do WhatsApp
  let senderJid = key.participant || message.participant || payload.participant || remoteJid;
  const altJid = key.participantAlt || message.participantAlt || payload.participantAlt;

  if (senderJid && senderJid.includes('@lid') && altJid) {
    senderJid = altJid;
  }

  const telefone = onlyDigits(senderJid.split('@')[0]);
  const isGroup = remoteJid.endsWith('@g.us') || remoteJid === process.env.WHATSAPP_GROUP_ID;

  return {
    event,
    text: String(text || '').trim(),
    telefone,
    nome: pushName || telefone,
    remoteJid,
    isGroup,
    fromMe
  };
}

module.exports = {
  sendText,
  sendGroupMessage,
  sendPrivateMessage,
  extractWebhookMessage
};