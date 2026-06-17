require('dotenv').config();
const express = require('express');
const path = require('path');
const { Database } = require('./database');
const whatsapp = require('./whatsapp');
const { handleCommand, formatResumo } = require('./handlers');
const { startScheduler } = require('./scheduler');

const app = express();
const db = new Database();
const services = { db, whatsapp };

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Middleware de autenticação
function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (process.env.ADMIN_API_TOKEN && token !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

// --- Rotas de API ---
app.get('/api/status', (req, res) => res.json({ 
  rodada: db.getState().rodada, 
  aberto: db.getState().aberto, 
  resumo: db.resumo(), 
  mensalistas: db.getState().mensalistas, 
  avulsos: db.getState().avulsos 
}));

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

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
  // Extrai a mensagem (o extractWebhookMessage já trata o sender/participant)
  const message = whatsapp.extractWebhookMessage(req.body);
  
  // Captura o sender do corpo do JSON da Evolution para ter certeza absoluta
  const senderFromRaw = req.body.data?.sender || '';
  const senderPhone = senderFromRaw.split('@')[0].replace(/\D/g, '');
  
  // Prioriza o telefone da mensagem, se falhar, usa o sender
  const telefoneFinal = message.telefone || senderPhone;

  const pollUpdate = req.body.data?.message?.pollUpdateMessage;

  // Atualização via Enquete
  if (pollUpdate) {
    console.log(`Diagnóstico: Enquete recebida. Telefone detectado: ${telefoneFinal}`);
    
    try {
      const pollData = await whatsapp.getPollStatus(pollUpdate.pollCreationMessageKey.id);
      
      if (pollData && pollData.pollUpdates) {
        const votouSim = pollData.pollUpdates[0]?.voters?.some(v => v.includes(telefoneFinal));
        const votouNao = pollData.pollUpdates[1]?.voters?.some(v => v.includes(telefoneFinal));
        
        const status = votouSim ? 'sim' : (votouNao ? 'nao' : 'pendente');
        const sucesso = db.updatePlayerStatus(telefoneFinal, status);
        
        console.log(`[Webhook] Jogador ${telefoneFinal} votou: ${status}. Salvo: ${sucesso}`);
      }
    } catch (e) {
      console.error("Erro ao processar estado da enquete:", e);
    }
    return res.json({ ok: true });
  }

  // Comandos de texto
  if (!message.fromMe && message.text.startsWith('/')) {
    try {
      const reply = await handleCommand({ ...message, telefone: telefoneFinal }, services);
      if (reply) await whatsapp.sendText(message.isGroup ? message.remoteJid : telefoneFinal, reply);
    } catch (e) { 
      console.error("Erro ao processar comando:", e); 
    }
  }
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Futebol Bot rodando na porta ${port}`);
    startScheduler(services);
});