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

// Adicione esta rota no seu src/index.js
app.get('/api/vagas', (req, res) => {
  res.json({ totalVagas: db.getState().configuracoes?.totalVagas || 20 });
});

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

// Rotas API
app.get('/api/status', (req, res) => res.json({ rodada: db.getState().rodada, aberto: db.getState().aberto, resumo: db.resumo(), mensalistas: db.getState().mensalistas, avulsos: db.getState().avulsos }));
app.post('/api/acao/nova-semana', (req, res) => { db.novaSemana(); res.json({ ok: true }); });
app.post('/api/mensalista', (req, res) => { db.addMensalista(req.body.telefone, req.body.nome); res.json({ ok: true }); });

// Substitua o app.listen atual por este bloco:
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Futebol Bot rodando na porta ${port}`);
});