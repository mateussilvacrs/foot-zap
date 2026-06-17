require('dotenv').config();

const express = require('express');
const path = require('path');
const { Database } = require('./database');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const { handleCommand, formatResumo } = require('./handlers');
const { startScheduler } = require('./scheduler');
const { createRoutes } = require('./routes');

const app = express();
const db = new Database();
const services = { db, whatsapp, sheets };

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Middleware de autenticação para as rotas administrativas
function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (process.env.ADMIN_API_TOKEN && token !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado. Verifique seu token.' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true, name: 'Futebol Bot', at: new Date().toISOString() }));

app.get('/api/status', (req, res) => {
  res.json({
    rodada: db.getState().rodada,
    aberto: db.getState().aberto,
    resumo: db.resumo(),
    mensalistas: db.getState().mensalistas,
    avulsos: db.getState().avulsos
  });
});

app.get('/api/vagas', (req, res) => {
  res.json({ totalVagas: db.getState().configuracoes.totalVagas });
});

app.post('/api/vagas', authMiddleware, (req, res) => {
  const { totalVagas } = req.body;
  const state = db.getState();
  state.configuracoes.totalVagas = Number(totalVagas);
  db.save();
  res.json({ ok: true, totalVagas: state.configuracoes.totalVagas });
});

// --- NOVAS ROTAS DA ENQUETE E GERENCIAMENTO INDIVIDUAL ---

// --- NOVAS ROTAS DA ENQUETE E GERENCIAMENTO INDIVIDUAL ---

app.post('/api/poll/create', authMiddleware, async (req, res) => {
  try {
    const question = req.body.question || '⚽ Confirmação - Futebol de Quarta';
    const options = ['✅ Vou jogar', '❌ Não vou'];
    const groupId = process.env.WHATSAPP_GROUP_ID;
    
    await whatsapp.sendPoll(groupId, question, options);
    db.setPoll(question);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/poll/close', authMiddleware, async (req, res) => {
  try {
    // Apenas encerra a enquete visualmente no painel, não manda mensagem ainda
    db.closePoll();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/poll/liberar-avulsos', authMiddleware, async (req, res) => {
  try {
    db.setAberto(true); // Libera o uso do /querojogar no WhatsApp
    const vagas = db.vagasRestantes();
    const mensagem = `🔥 *Vagas abertas para Avulsos!*\n\nTemos *${vagas} vagas* disponíveis para a pelada.\n\nQuem quiser jogar, mande *exatamente* o comando abaixo aqui no grupo ou no meu privado:\n\n*/querojogar*`;
    
    await whatsapp.sendGroupMessage(mensagem);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/poll/finalizar', authMiddleware, async (req, res) => {
  try {
    db.setAberto(false); // Fecha a entrada de avulsos
    db.liberarAvulsos(); // Move os avulsos de "espera" para "confirmado" se couber nas vagas
    const resumo = formatResumo(db); // Gera o textão da lista final
    await whatsapp.sendGroupMessage(resumo);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/player/:telefone/status', authMiddleware, (req, res) => {
  const { status } = req.body; 
  db.updatePlayerStatus(req.params.telefone, status);
  res.json({ ok: true });
});

app.delete('/api/player/:telefone/avulso', authMiddleware, (req, res) => {
  db.removeAvulso(req.params.telefone);
  res.json({ ok: true });
});
// -----------------------------------------------------------

app.post('/api/poll/close', authMiddleware, async (req, res) => {
  try {
    db.closePoll();
    db.setAberto(false);
    db.liberarAvulsos();
    const resumo = formatResumo(db);
    await whatsapp.sendGroupMessage(resumo);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/player/:telefone/status', authMiddleware, (req, res) => {
  const { status } = req.body; // 'sim', 'nao', 'pendente', 'confirmado', 'espera'
  db.updatePlayerStatus(req.params.telefone, status);
  res.json({ ok: true });
});

app.delete('/api/player/:telefone/avulso', authMiddleware, (req, res) => {
  db.removeAvulso(req.params.telefone);
  res.json({ ok: true });
});

// -----------------------------------------------------------

app.post('/webhook', async (req, res) => {
  const message = whatsapp.extractWebhookMessage(req.body);

  // LOG TEMPORÁRIO PARA ENQUETES: Mostra no log quando alguém vota
  if (req.body.data && req.body.data.message && req.body.data.message.pollUpdateMessage) {
    console.log("VOTO DE ENQUETE DETECTADO!", JSON.stringify(req.body, null, 2));
  }

  if (message.fromMe || !message.text) return res.json({ ok: true, ignored: true });

  try {
    const reply = await handleCommand(message, services);
    if (reply) {
      const destination = message.isGroup ? message.remoteJid : message.telefone;
      await whatsapp.sendText(destination, reply);
    }
    res.json({ ok: true, handled: Boolean(reply) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'Erro ao processar webhook.' });
  }
});

app.use('/api', createRoutes(services));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Futebol Bot rodando na porta ${port}`));
startScheduler(services);