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
 * Busca os participantes do grupo via Evolution API.
 * Tenta dois endpoints diferentes para compatibilidade com v1 e v2.
 */
async function getGroupParticipants(groupId) {
  const { instance, apiUrl, apiKey } = requiredConfig();

  // Tenta endpoint v2 primeiro, depois v1 como fallback
  const endpoints = [
    `/group/participants/${instance}?groupJid=${groupId}`,
    `/group/findParticipants/${instance}?groupJid=${groupId}`
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(`${apiUrl}${ep}`, {
        headers: { 'Content-Type': 'application/json', apikey: apiKey }
      });
      if (!res.ok) continue;
      const data = await res.json();
      // Diferentes versões retornam em campos diferentes
      const list =
        data?.participants ||
        data?.response?.participants ||
        data?.data?.participants ||
        (Array.isArray(data) ? data : []);
      const jids = list.map(p => p.id || p.jid || p).filter(s => typeof s === 'string' && s.includes('@'));
      if (jids.length) return jids;
    } catch (_) { /* tenta próximo */ }
  }

  console.warn('[WA] Não foi possível buscar participantes do grupo');
  return [];
}

/**
 * Envia mensagem no grupo configurado em WHATSAPP_GROUP_ID.
 * Se mencionar=true, busca participantes e passa o array `mentioned`
 * que é obrigatório para o @todos funcionar na Evolution API.
 */
async function sendGroupMessage(text, mencionar = false) {
  const { groupId, instance } = requiredConfig();
  if (!groupId) throw new Error('WHATSAPP_GROUP_ID não configurado.');

  // Detecta @todos inline no texto OU flag explícita
  const temMarcacao =
    mencionar ||
    text.includes('@todos') ||
    text.includes('@everyone') ||
    text.includes('@all');

  if (temMarcacao) {
    // Remove marcadores do texto — o WhatsApp mostra a menção nativa
    const textoLimpo = text
      .replace(/@todos|@everyone|@all/gi, '')
      .trim();

    const participants = await getGroupParticipants(groupId);

    return postEvolution(`/message/sendText/${instance}`, {
      number: groupId,
      text: textoLimpo || text.trim(),
      mentioned: participants,        // obrigatório para menção funcionar
      options: {
        delay: 800,
        mentionsEveryOne: true,
        mentioned: participants       // Evolution v1 aceita aqui, v2 no raiz
      }
    });
  }

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
  getGroupParticipants,
  sendPrivateMessage,
  sendPoll,
  getPollStatus,
  extractWebhookMessage
};