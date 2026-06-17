require('dotenv').config();
const express = require('express');
const { Database, onlyDigits } = require('./database');
const whatsapp = require('./whatsapp');
const { handleCommand, formatResumo } = require('./handlers');

const app = express();
const db = new Database();
const services = { db, whatsapp };

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (process.env.ADMIN_API_TOKEN && req.headers['x-admin-token'] !== process.env.ADMIN_API_TOKEN) 
    return res.status(401).json({ error: 'Não autorizado.' });
  next();
}

// ROTAS QUE SEU INDEX.HTML CHAMA
app.get('/api/status', (req, res) => res.json({ 
  rodada: db.getState().rodada, aberto: db.getState().aberto, 
  resumo: db.resumo(), mensalistas: db.getState().mensalistas, avulsos: db.getState().avulsos 
}));

app.get('/api/vagas', (req, res) => res.json({ totalVagas: db.getState().configuracoes.totalVagas }));

app.post('/api/vagas', authMiddleware, (req, res) => {
  db.getState().configuracoes.totalVagas = Number(req.body.totalVagas);
  db.save();
  res.json({ ok: true });
});

app.post('/api/mensalista', authMiddleware, (req, res) => {
  db.addMensalista(req.body.telefone, req.body.nome);
  res.json({ ok: true });
});

app.delete('/api/mensalista/:telefone', authMiddleware, (req, res) => {
  db.removeMensalista(req.params.telefone);
  res.json({ ok: true });
});

app.delete('/api/player/:telefone/avulso', authMiddleware, (req, res) => {
  db.removeAvulso(req.params.telefone);
  res.json({ ok: true });
});

app.patch('/api/player/:telefone/status', authMiddleware, (req, res) => {
  db.updatePlayerStatus(req.params.telefone, req.body.status);
  res.json({ ok: true });
});

app.post('/api/poll/create', authMiddleware, async (req, res) => {
  await whatsapp.sendPoll(process.env.WHATSAPP_GROUP_ID, req.body.question, ['✅ Vou jogar', '❌ Não vou']);
  db.setPoll(req.body.question);
  res.json({ ok: true });
});

app.post('/api/poll/close', authMiddleware, (req, res) => { db.closePoll(); res.json({ ok: true }); });

app.post('/api/poll/liberar-avulsos', authMiddleware, async (req, res) => {
  db.setAberto(true);
  res.json({ ok: true });
});

app.post('/api/poll/finalizar', authMiddleware, async (req, res) => {
  db.setAberto(false);
  db.liberarAvulsos();
  await whatsapp.sendGroupMessage(formatResumo(db));
  res.json({ ok: true });
});

app.post('/api/acao/nova-semana', authMiddleware, (req, res) => {
  db.novaSemana();
  res.json({ ok: true });
});

app.post('/api/acao/mensagem', authMiddleware, async (req, res) => {
  await whatsapp.sendGroupMessage(req.body.mensagem);
  res.json({ ok: true });
});

// WEBHOOK
app.post('/webhook', async (req, res) => {
  const message = whatsapp.extractWebhookMessage(req.body);
  const senderPhone = onlyDigits(req.body.data?.sender?.split('@')[0] || '');
  const telefoneFinal = message.telefone || senderPhone;
  const pollUpdate = req.body.data?.message?.pollUpdateMessage;

  if (pollUpdate) {
    try {
      const pollData = await whatsapp.getPollStatus(pollUpdate.pollCreationMessageKey.id);
      if (pollData?.pollUpdates) {
        const sim = pollData.pollUpdates[0]?.voters?.some(v => onlyDigits(v).includes(telefoneFinal));
        const nao = pollData.pollUpdates[1]?.voters?.some(v => onlyDigits(v).includes(telefoneFinal));
        db.updatePlayerStatus(telefoneFinal, sim ? 'sim' : (nao ? 'nao' : 'pendente'));
      }
    } catch (e) { console.error(e); }
  } else if (!message.fromMe && message.text.startsWith('/')) {
    const reply = await handleCommand({ ...message, telefone: telefoneFinal }, services);
    if (reply) await whatsapp.sendText(message.isGroup ? message.remoteJid : telefoneFinal, reply);
  }
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Rodando na porta ${port}`));