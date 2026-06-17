require('dotenv').config();
const express = require('express');
const { Database, onlyDigits } = require('./database');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const { handleCommand, formatResumo, mensagemConvocacao } = require('./handlers');

const app = express();
const db = new Database();
const services = { db, whatsapp, sheets };

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ─── Rota de debug — REMOVA EM PRODUÇÃO ───────────────────────────────────────
// Acesse GET /debug/last-webhook para ver o último payload recebido
let lastWebhookPayload = null;
app.use((req, res, next) => {
  if (req.path === '/webhook' && req.method === 'POST') {
    // Intercepta antes do handler para guardar o payload bruto
    const originalJson = res.json.bind(res);
    lastWebhookPayload = req.body;
  }
  next();
});
app.get('/debug/last-webhook', (req, res) => {
  res.json(lastWebhookPayload || { msg: 'Nenhum webhook recebido ainda.' });
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token =
    req.headers['x-admin-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (process.env.ADMIN_API_TOKEN && token !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

// ─── Webhook WhatsApp ──────────────────────────────────────────────────────────

// Loga o payload completo em desenvolvimento para facilitar debug
function logWebhook(body) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[WEBHOOK]', JSON.stringify(body, null, 2));
  }
}

// Extrai o número do remetente a partir das várias estruturas que a Evolution API usa
function extractSenderPhone(body) {
  const data = body.data || body;

  // Formato v2: sender direto
  if (data.sender) return onlyDigits(data.sender.split('@')[0]);

  const key = data.key || data.message?.key || {};
  const participant = key.participant || data.participant || '';
  if (participant) return onlyDigits(participant.split('@')[0]);

  const remoteJid = key.remoteJid || '';
  if (remoteJid && !remoteJid.endsWith('@g.us')) {
    return onlyDigits(remoteJid.split('@')[0]);
  }

  return '';
}

app.post('/webhook', async (req, res) => {
  res.json({ ok: true }); // responde imediatamente para a Evolution não reenviar

  try {
    const body = req.body;
    logWebhook(body);

    const event = body.event || body.type || '';
    const data  = body.data || body;

    // ── Detecta voto em enquete ──────────────────────────────────────────────
    // A Evolution API envia event === 'messages.update' com pollUpdateMessage
    // OU event === 'POLL_UPDATE' dependendo da versão/configuração
    const isPollEvent =
      event === 'POLL_UPDATE' ||
      event === 'messages.update' ||
      data?.message?.pollUpdateMessage !== undefined ||
      data?.pollUpdateMessage !== undefined;

    if (isPollEvent) {
      const pollUpdate =
        data?.message?.pollUpdateMessage ||
        data?.pollUpdateMessage ||
        data;

      // O telefone do votante vem no remetente do evento de update
      const telefoneVotante = extractSenderPhone(body);

      if (!telefoneVotante) {
        console.warn('[POLL] Não foi possível identificar o telefone do votante', body);
        return;
      }

      // selectedOptions vem direto no pollUpdateMessage da Evolution v2
      // É um array com os nomes das opções selecionadas pelo usuário
      const selectedOptions = (
        pollUpdate?.selectedOptions ||
        pollUpdate?.vote?.selectedOptions ||
        []
      ).map(o => (typeof o === 'string' ? o : o?.name || o?.optionName || '').toLowerCase());

      console.log('[POLL] Votante:', telefoneVotante, '| Opções:', selectedOptions);

      let novoStatus;
      if (selectedOptions.some(o => o.includes('vou jogar') || o.includes('sim') || o.startsWith('✅'))) {
        novoStatus = 'sim';
      } else if (selectedOptions.some(o => o.includes('não vou') || o.includes('nao') || o.startsWith('❌'))) {
        novoStatus = 'nao';
      } else {
        // Array vazio = usuário retirou o voto
        novoStatus = 'pendente';
      }

      const atualizado = db.updatePlayerStatus(telefoneVotante, novoStatus);
      console.log('[POLL] Status atualizado:', { telefoneVotante, novoStatus, atualizado });
      return;
    }

    // ── Mensagem de texto ────────────────────────────────────────────────────
    const message = whatsapp.extractWebhookMessage(body);
    const telefoneFinal = extractSenderPhone(body) || message.telefone;

    if (!message.fromMe && message.text?.startsWith('/')) {
      const ctx = { ...message, telefone: telefoneFinal };
      const reply = await handleCommand(ctx, services);
      if (reply) {
        const dest = message.isGroup ? message.remoteJid : telefoneFinal;
        await whatsapp.sendText(dest, reply);
      }
    }

  } catch (e) {
    console.error('[WEBHOOK] Erro:', e);
  }
});

// ─── API REST ──────────────────────────────────────────────────────────────────

// Status geral
app.get('/api/status', authMiddleware, (req, res) => {
  res.json({
    rodada: db.getState().rodada,
    aberto: db.getState().aberto,
    pollId: db.getState().pollId || null,
    resumo: db.resumo(),
    mensalistas: db.getState().mensalistas,
    avulsos: db.getState().avulsos,
    configuracoes: db.getState().configuracoes
  });
});

// Criar enquete no grupo
app.post('/api/poll/create', authMiddleware, async (req, res) => {
  try {
    const question = req.body.question || '⚽ Futebol desta semana — você vai?';
    const result = await whatsapp.sendPoll(
      process.env.WHATSAPP_GROUP_ID,
      question,
      ['✅ Vou jogar', '❌ Não vou']
    );

    // Salva o ID da enquete para poder correlacionar votos depois
    const pollId = result?.key?.id || result?.messageId || null;
    db.setPoll(pollId);

    res.json({ ok: true, pollId });
  } catch (e) {
    console.error('Erro ao criar enquete:', e);
    res.status(500).json({ error: e.message });
  }
});

// Resetar enquete — todos os mensalistas voltam para pendente
app.post('/api/poll/reset', authMiddleware, (req, res) => {
  const resumo = db.resetarEnquete();
  res.json({ ok: true, resumo });
});

// Vagas
app.get('/api/vagas', authMiddleware, (req, res) => {
  res.json({ totalVagas: db.getState().configuracoes?.totalVagas || 25 });
});
app.post('/api/vagas', authMiddleware, (req, res) => {
  if (!db.getState().configuracoes) db.getState().configuracoes = {};
  db.getState().configuracoes.totalVagas = Number(req.body.totalVagas);
  db.save();
  res.json({ ok: true });
});

// Nova semana
app.post('/api/acao/nova-semana', authMiddleware, (req, res) => {
  const resumo = db.novaSemana(req.body.rodada);
  res.json({ ok: true, resumo });
});

// Mensalistas
app.get('/api/mensalistas', authMiddleware, (req, res) => {
  res.json(db.getState().mensalistas);
});
app.post('/api/mensalista', authMiddleware, (req, res) => {
  try {
    const lista = db.addMensalista(req.body.telefone, req.body.nome);
    res.status(201).json({ ok: true, mensalistas: lista });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/mensalista/:telefone', authMiddleware, (req, res) => {
  const removed = db.removeMensalista(req.params.telefone);
  res.json({ ok: true, removed });
});

// Abrir / fechar rodada
app.post('/api/acao/abrir', authMiddleware, (req, res) => {
  res.json(db.setAberto(true));
});
app.post('/api/acao/fechar', authMiddleware, async (req, res) => {
  db.setAberto(false);
  db.liberarAvulsos();
  await sheets.syncResumo(db).catch(e => db.log('Erro Sheets', { error: e.message }));
  const resumoTexto = formatResumo(db);
  await whatsapp.sendGroupMessage(resumoTexto).catch(e => console.error(e));
  res.json({ ok: true, resumo: db.resumo() });
});

// Convocar
app.post('/api/acao/convocar', authMiddleware, async (req, res) => {
  await whatsapp.sendGroupMessage(mensagemConvocacao());
  res.json({ ok: true });
});

// Alterar status de qualquer jogador manualmente pelo dashboard
app.patch('/api/player/:telefone/status', authMiddleware, (req, res) => {
  const tel    = req.params.telefone;
  const status = req.body.status;
  const validos = ['sim', 'nao', 'pendente', 'confirmado', 'espera'];
  if (!validos.includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }
  const atualizado = db.updatePlayerStatus(tel, status);
  if (!atualizado) return res.status(404).json({ error: 'Jogador não encontrado.' });
  res.json({ ok: true });
});

// Remover avulso pelo dashboard
app.delete('/api/avulso/:telefone', authMiddleware, (req, res) => {
  const tel = req.params.telefone.replace(/\D/g, '');
  const antes = db.getState().avulsos.length;
  db.getState().avulsos = db.getState().avulsos.filter(a => a.telefone !== tel);
  db.save();
  res.json({ ok: true, removed: db.getState().avulsos.length < antes });
});

// Resumo
app.post('/api/acao/resumo', authMiddleware, async (req, res) => {
  const texto = formatResumo(db);
  await whatsapp.sendGroupMessage(texto).catch(e => console.error(e));
  res.json({ ok: true, resumo: db.resumo() });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`⚽ Futebol Bot rodando na porta ${port}`);
});