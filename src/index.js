require('dotenv').config();

const express = require('express');
const path = require('path');
const { Database } = require('./database');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const { handleCommand } = require('./handlers');
const { startScheduler } = require('./scheduler');
const { createRoutes } = require('./routes');

const app = express();
const db = new Database();
const services = { db, whatsapp, sheets };

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, name: 'Futebol Bot', at: new Date().toISOString() });
});

app.post('/webhook', async (req, res) => {
  const message = whatsapp.extractWebhookMessage(req.body);

  if (message.fromMe || !message.text) {
    return res.json({ ok: true, ignored: true });
  }

  if (message.event && message.event !== 'MESSAGES_UPSERT' && message.event !== 'messages.upsert') {
    return res.json({ ok: true, ignored: true, event: message.event });
  }

  try {
    const reply = await handleCommand(message, services);
    if (reply) {
      const destination = message.isGroup ? message.remoteJid : message.telefone;
      await whatsapp.sendText(destination, reply);
    }
    res.json({ ok: true, handled: Boolean(reply) });
  } catch (error) {
    db.log('Erro no webhook', { error: error.message });
    console.error(error);
    res.status(500).json({ ok: false, error: 'Erro ao processar webhook.' });
  }
});

app.use('/api', createRoutes(services));

app.use((req, res) => {
  res.status(404).json({ error: 'Rota nao encontrada.' });
});

app.use((error, req, res, next) => {
  db.log('Erro HTTP', { error: error.message, path: req.path });
  console.error(error);
  res.status(500).json({ error: error.message || 'Erro interno.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Futebol Bot rodando na porta ${port}`);
});

startScheduler(services);
