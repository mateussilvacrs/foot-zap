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

// Rota do Webhook com prioridade no SENDER
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
    } catch (e) { console.error("Erro Enquete:", e); }
  } else if (!message.fromMe && message.text?.startsWith('/')) {
    const reply = await handleCommand({ ...message, telefone: telefoneFinal }, services);
    if (reply) await whatsapp.sendText(message.isGroup ? message.remoteJid : telefoneFinal, reply);
  }
  res.json({ ok: true });
});

// Rotas Administrativas
app.post('/api/poll/create', async (req, res) => {
  try {
    await whatsapp.sendPoll(process.env.WHATSAPP_GROUP_ID, req.body.question, ['✅ Vou jogar', '❌ Não vou']);
    db.setPoll(req.body.question);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/acao/nova-semana', (req, res) => { db.novaSemana(); res.json({ ok: true }); });
app.get('/api/status', (req, res) => res.json({ rodada: db.getState().rodada, aberto: db.getState().aberto, resumo: db.resumo(), mensalistas: db.getState().mensalistas, avulsos: db.getState().avulsos }));
app.patch('/api/player/:telefone/status', (req, res) => { db.updatePlayerStatus(req.params.telefone, req.body.status); res.json({ ok: true }); });

app.listen(3000, () => console.log('Bot rodando na porta 3000'));