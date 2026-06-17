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

// Rotas de API
app.get('/api/status', (req, res) => res.json({ 
  rodada: db.getState().rodada, 
  aberto: db.getState().aberto, 
  resumo: db.resumo(), 
  mensalistas: db.getState().mensalistas, 
  avulsos: db.getState().avulsos 
}));

app.get('/api/vagas', (req, res) => res.json({ totalVagas: db.getState().configuracoes.totalVagas }));

app.post('/api/vagas', authMiddleware, (req, res) => {
  db.getState().configuracoes.totalVagas = Number(req.body.totalVagas);
  db.save();
  res.json({ ok: true });
});

// Rotas da Enquete
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

// Ações de Jogadores
app.patch('/api/player/:telefone/status', authMiddleware, (req, res) => {
  db.updatePlayerStatus(req.params.telefone, req.body.status);
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

app.post('/api/mensalista', authMiddleware, (req, res) => {
  db.addMensalista(req.body.telefone, req.body.nome);
  res.json({ ok: true });
});

app.post('/api/acao/mensagem', authMiddleware, async (req, res) => {
  await whatsapp.sendGroupMessage(req.body.mensagem);
  res.json({ ok: true });
});

app.post('/api/acao/nova-semana', authMiddleware, (req, res) => {
  db.novaSemana();
  res.json({ ok: true });
});

// WEBHOOK
// WEBHOOK CORRIGIDO
app.post('/webhook', async (req, res) => {
  const message = whatsapp.extractWebhookMessage(req.body);
  const pollUpdate = req.body.data?.message?.pollUpdateMessage;

  // Atualização automática via enquete
  if (pollUpdate && pollUpdate.pollUpdates) {
    const telefoneVotante = message.telefone;
    
    console.log(`Diagnóstico: Bot tentando atualizar o telefone: ${telefoneVotante}`);

    // Verifica os votos (pollUpdates[0] = Sim, [1] = Não)
    const votouSim = pollUpdate.pollUpdates[0]?.voters?.some(v => v.includes(telefoneVotante)) || false;
    const votouNao = pollUpdate.pollUpdates[1]?.voters?.some(v => v.includes(telefoneVotante)) || false;
    
    let status = 'pendente';
    if (votouSim) status = 'sim';
    else if (votouNao) status = 'nao';
    
    // CORREÇÃO: Usando a variável correta 'telefoneVotante'
    const sucesso = db.updatePlayerStatus(telefoneVotante, status);
    
    console.log(`[Webhook] Jogador ${telefoneVotante} votou: ${status}. Atualização: ${sucesso ? 'OK' : 'Falha (Telefone não cadastrado no estado.json)'}`);
    
    return res.json({ ok: true });
  }

  // Comandos de texto
  if (!message.fromMe && message.text.startsWith('/')) {
    try {
      const reply = await handleCommand(message, services);
      if (reply) await whatsapp.sendText(message.isGroup ? message.remoteJid : message.telefone, reply);
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