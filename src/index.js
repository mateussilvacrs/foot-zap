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
    // Evolution v2.3.7: messageType='pollUpdateMessage'
    // - Telefone real do votante: data.key.participantAlt (ex: "5511983884799@s.whatsapp.net")
    // - Votos: data.pollUpdates[{ name, voters: [jid, ...] }]
    //   voters pode conter o participantAlt OU o participant (LID) do votante
    const isPollEvent =
      data?.messageType === 'pollUpdateMessage' ||
      data?.message?.pollUpdateMessage !== undefined;

    if (isPollEvent) {
      // ── Garante que é a enquete criada pelo bot ──────────────────────────
      const pollIdAtual = db.getState().pollId;
      const msgId = data?.key?.id || data?.messageId || '';

      if (pollIdAtual && msgId && msgId !== pollIdAtual) {
        console.log('[POLL] Ignorado — pertence a outra enquete:', { msgId, pollIdAtual });
        return;
      }

      // Telefone real (número internacional, sem LID)
      const participantAlt = data?.key?.participantAlt || '';   // "5511983884799@s.whatsapp.net"
      const participantLid = data?.key?.participant    || '';   // "267739805548693@lid"
      const telefoneVotante = onlyDigits(participantAlt.split('@')[0]);

      if (!telefoneVotante) {
        console.warn('[POLL] participantAlt ausente:', JSON.stringify(data?.key));
        return;
      }

      // pollUpdates vem no data raiz: [{ name: "✅ Vou jogar", voters: [...] }, ...]
      // voters é array de JIDs — pode ser participantAlt ou participantLid dependendo do endereçamento
      const pollUpdates = data?.pollUpdates || [];

      const esteVotante = (voters = []) =>
        voters.some(v => {
          const jid = String(v);
          return (
            onlyDigits(jid.split('@')[0]) === telefoneVotante ||   // match por número
            jid === participantLid ||                               // match por LID
            jid === participantAlt                                  // match por JID completo
          );
        });

      // Encontra qual opção este votante escolheu
      const opcaoVotada = pollUpdates.find(opt => esteVotante(opt.voters));

      console.log('[POLL]', {
        telefoneVotante,
        participantLid,
        opcaoVotada: opcaoVotada?.name ?? '(nenhuma — retirou voto)',
        pollUpdates: pollUpdates.map(o => ({ name: o.name, voters: o.voters }))
      });

      let novoStatus;
      if (!opcaoVotada) {
        novoStatus = 'pendente'; // retirou o voto
      } else {
        const nome = opcaoVotada.name.toLowerCase();
        if (nome.includes('vou jogar') || nome.includes('sim') || nome.startsWith('✅')) {
          novoStatus = 'sim';
        } else {
          novoStatus = 'nao';
        }
      }

      const atualizado = db.updatePlayerStatus(telefoneVotante, novoStatus);
      console.log('[POLL] Resultado:', { telefoneVotante, novoStatus, atualizado });
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

// Fechar só as inscrições de avulsos (sem fechar a rodada toda)
app.post('/api/acao/fechar-avulsos', authMiddleware, (req, res) => {
  res.json(db.setAberto(false));
});

// Adicionar avulso manualmente pelo dashboard (sem exigir que a rodada esteja aberta)
app.post('/api/avulso', authMiddleware, (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório.' });

  const tel = String(telefone || '').replace(/\D/g, '') || `manual_${Date.now()}`;

  const jaExiste = db.getState().avulsos.find(a => a.telefone === tel && tel !== `manual_${Date.now()}`);
  if (jaExiste) return res.status(400).json({ error: 'Avulso já cadastrado com esse telefone.' });

  const { confirmados, avulsos: avulsosConf } = db.resumo();
  const totalOcupado = confirmados.length + avulsosConf.length;
  const vagasRestantes = db.getState().configuracoes.totalVagas - totalOcupado;

  const jogador = {
    telefone: tel,
    nome: nome.trim(),
    status: vagasRestantes > 0 ? 'confirmado' : 'espera'
  };

  db.getState().avulsos.push(jogador);
  db.save();
  res.status(201).json({ ok: true, jogador });
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

// Mensagem livre no grupo (corrige 404 do dashboard)
app.post('/api/acao/mensagem', authMiddleware, async (req, res) => {
  const mensagem = String(req.body.mensagem || '').trim();
  if (!mensagem || mensagem.length < 2) {
    return res.status(400).json({ error: 'Mensagem obrigatória.' });
  }
  await whatsapp.sendGroupMessage(mensagem).catch(e => console.error(e));
  res.json({ ok: true });
});

// Avulso desiste — remove e promove próximo da fila de espera
app.post('/api/avulso/:telefone/desistir', authMiddleware, async (req, res) => {
  const { removido, jogador, promovido } = db.desistirAvulso(req.params.telefone);
  if (!removido) return res.status(404).json({ error: 'Avulso não encontrado.' });

  // Notifica o promovido via WhatsApp privado
  if (promovido) {
    const valor = db.getState().configuracoes.valorAvulso;
    await whatsapp.sendPrivateMessage(
      promovido.telefone,
      `⚽ Boa notícia, ${promovido.nome}! Uma vaga abriu e você saiu da fila de espera.\nVocê está confirmado para o jogo desta semana! Valor: R$ ${valor} ⚽`
    ).catch(e => db.log('Erro ao notificar promovido', { error: e.message }));
  }

  res.json({ ok: true, jogador, promovido });
});

// ─── Comandos personalizados ───────────────────────────────────────────────────
app.get('/api/comandos', authMiddleware, (req, res) => {
  res.json(db.getComandos());
});

app.post('/api/comandos', authMiddleware, (req, res) => {
  try {
    const { gatilho, descricao, tipo, resposta } = req.body;
    if (!gatilho) return res.status(400).json({ error: 'Gatilho obrigatório.' });
    if (tipo === 'mensagem' && !resposta) return res.status(400).json({ error: 'Resposta obrigatória para tipo mensagem.' });
    const cmd = db.addComando({ gatilho, descricao, tipo, resposta });
    res.status(201).json(cmd);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/comandos/:id', authMiddleware, (req, res) => {
  const cmd = db.updateComando(req.params.id, req.body);
  if (!cmd) return res.status(404).json({ error: 'Comando não encontrado.' });
  res.json(cmd);
});

app.post('/api/comandos/:id/resetar', authMiddleware, (req, res) => {
  const cmd = db.resetarContador(req.params.id);
  if (!cmd) return res.status(404).json({ error: 'Comando não encontrado ou não é contador.' });
  res.json({ ok: true, cmd });
});

app.delete('/api/comandos/:id', authMiddleware, (req, res) => {
  const removed = db.removeComando(req.params.id);
  res.json({ ok: removed });
});

// ─── Admins ────────────────────────────────────────────────────────────────────

app.get('/api/admins', authMiddleware, (req, res) => {
  res.json(db.getAdmins());
});

app.post('/api/admin', authMiddleware, async (req, res) => {
  try {
    const { telefone, nome } = req.body;
    if (!telefone) return res.status(400).json({ error: 'Telefone obrigatório.' });
    const admin = db.addAdmin(telefone, nome || '');

    // Notifica o novo admin via WhatsApp privado
    await whatsapp.sendPrivateMessage(
      admin.telefone,
      `🔐 Olá${admin.nome ? `, ${admin.nome}` : ''}! Você agora é administrador do Futebol Bot.\n\nVocê pode usar os comandos /admin no privado do bot.`
    ).catch(e => db.log('Erro ao notificar novo admin', { error: e.message }));

    res.status(201).json({ ok: true, admin });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/:telefone', authMiddleware, async (req, res) => {
  const removed = db.removeAdmin(req.params.telefone);
  if (!removed) return res.status(404).json({ error: 'Admin não encontrado.' });

  // Notifica remoção
  const tel = req.params.telefone.replace(/\D/g, '');
  await whatsapp.sendPrivateMessage(
    tel,
    '🔒 Você foi removido da lista de administradores do Futebol Bot.'
  ).catch(() => {});

  res.json({ ok: true, removed });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`⚽ Futebol Bot rodando na porta ${port}`);
});