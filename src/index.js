require('dotenv').config();
const express = require('express');
const { Database } = require('./database');
const whatsapp = require('./whatsapp');
const { handleCommand, formatResumo } = require('./handlers');

const app = express();
const db = new Database();
const services = { db, whatsapp };

app.use(express.json());
app.use(express.static('public'));

function authMiddleware(req, res, next) {
  if (process.env.ADMIN_API_TOKEN && req.headers['x-admin-token'] !== process.env.ADMIN_API_TOKEN) 
    return res.status(401).json({ error: 'Não autorizado.' });
  next();
}

// Rotas de Enquete e Status
app.get('/api/status', (req, res) => res.json({ rodada: db.getState().rodada, aberto: db.getState().aberto, resumo: db.resumo(), mensalistas: db.getState().mensalistas, avulsos: db.getState().avulsos }));

app.post('/api/poll/create', authMiddleware, async (req, res) => {
  await whatsapp.sendPoll(process.env.WHATSAPP_GROUP_ID, req.body.question, ['✅ Vou jogar', '❌ Não vou']);
  db.setPoll(req.body.question);
  res.json({ ok: true });
});

app.post('/api/poll/close', authMiddleware, (req, res) => { db.closePoll(); res.json({ ok: true }); });

app.post('/api/poll/liberar-avulsos', authMiddleware, async (req, res) => {
  db.setAberto(true);
  await whatsapp.sendGroupMessage(`🔥 Vagas abertas para Avulsos! Temos ${db.vagasRestantes()} vagas. Mande /querojogar`);
  res.json({ ok: true });
});

app.post('/api/poll/finalizar', authMiddleware, async (req, res) => {
  db.setAberto(false);
  db.liberarAvulsos();
  await whatsapp.sendGroupMessage(formatResumo(db));
  res.json({ ok: true });
});

app.patch('/api/player/:telefone/status', authMiddleware, (req, res) => {
  db.updatePlayerStatus(req.params.telefone, req.body.status);
  res.json({ ok: true });
});

// Webhook Inteligente
app.post('/webhook', async (req, res) => {
  const message = whatsapp.extractWebhookMessage(req.body);
  const pollUpdate = req.body.data?.message?.pollUpdateMessage;

  if (pollUpdate && pollUpdate.pollUpdates) {
    const votouSim = pollUpdate.pollUpdates[0]?.voters?.includes(message.telefone) || false;
    const votouNao = pollUpdate.pollUpdates[1]?.voters?.includes(telefone) || false; // Ajustado para capturar telefone
    db.updatePlayerStatus(message.telefone, votouSim ? 'sim' : (votouNao ? 'nao' : 'pendente'));
    return res.json({ ok: true });
  }

  if (!message.fromMe && message.text.startsWith('/')) {
    const reply = await handleCommand(message, services);
    if (reply) await whatsapp.sendText(message.isGroup ? message.remoteJid : message.telefone, reply);
  }
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Servidor rodando na porta 3000'));