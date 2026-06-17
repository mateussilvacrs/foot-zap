const { onlyDigits } = require('./database');

function requiredConfig() {
  return {
    apiUrl: process.env.EVOLUTION_API_URL?.replace(/\/$/, ''),
    apiKey: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE,
    groupId: process.env.WHATSAPP_GROUP_ID
  };
}

async function postEvolution(path, payload, method = 'POST') {
  const { apiUrl, apiKey } = requiredConfig();
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: payload ? JSON.stringify(payload) : null
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  return response.json();
}

/**
 * Envia texto para qualquer JID (número ou grupo).
 */
async function sendText(number, text) {
  const { instance } = requiredConfig();
  return postEvolution(`/message/sendText/${instance}`, {
    number,
    text,
    options: { delay: 800 }
  });
}

/**
 * Envia mensagem no grupo configurado em WHATSAPP_GROUP_ID.
 */
async function sendGroupMessage(text) {
  const { groupId } = requiredConfig();
  if (!groupId) throw new Error('WHATSAPP_GROUP_ID não configurado.');
  return sendText(groupId, text);
}

/**
 * Envia mensagem privada para um número (somente dígitos ou JID completo).
 */
async function sendPrivateMessage(telefone, text) {
  const number = onlyDigits(telefone);
  return sendText(number, text);
}

/**
 * Cria uma enquete no grupo.
 * Retorna o objeto da API (contém o messageId da enquete).
 */
async function sendPoll(number, name, optionsArray) {
  const { instance } = requiredConfig();
  return postEvolution(`/message/sendPoll/${instance}`, {
    number,
    name,
    selectableCount: 1,
    values: optionsArray
  });
}

/**
 * Busca o status atual de uma enquete pelo messageId.
 */
async function getPollStatus(messageId) {
  try {
    const { instance } = requiredConfig();
    const data = await postEvolution(
      `/message/find/${instance}?messageId=${messageId}`,
      null,
      'GET'
    );
    return data?.message?.pollUpdateMessage || null;
  } catch {
    return null;
  }
}

/**
 * Extrai dados relevantes do payload do webhook da Evolution API.
 */
function extractWebhookMessage(body = {}) {
  const payload = body.data || body;
  const message = payload.message || payload.messages?.[0] || payload;
  const key = message.key || payload.key || {};

  // Pega o número real do remetente (em grupos, participant; em privado, remoteJid)
  const realNumber =
    key.participantAlt ||
    payload.participantAlt ||
    key.participant ||
    payload.participant ||
    key.remoteJid ||
    '';

  const nome =
    payload.pushName ||
    message.pushName ||
    payload.notifyName ||
    '';

  return {
    text: (
      message.message?.conversation ||
      message.conversation ||
      message.text ||
      ''
    ).trim(),
    telefone: onlyDigits(realNumber.split('@')[0]),
    nome,
    remoteJid: key.remoteJid || '',
    isGroup: (key.remoteJid || '').endsWith('@g.us'),
    fromMe: Boolean(key.fromMe)
  };
}

module.exports = {
  sendText,
  sendGroupMessage,
  sendPrivateMessage,
  sendPoll,
  getPollStatus,
  extractWebhookMessage
};