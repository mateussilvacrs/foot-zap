const express = require('express');
const { formatResumo, mensagemConvocacao } = require('./handlers');

function createRoutes({ db, whatsapp, sheets }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.method === 'GET' || !process.env.ADMIN_API_TOKEN) return next();

    const header = req.get('x-admin-token') || '';
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (header === process.env.ADMIN_API_TOKEN || bearer === process.env.ADMIN_API_TOKEN) {
      return next();
    }

    return res.status(401).json({ error: 'Token administrativo invalido.' });
  });

  router.get('/status', (req, res) => {
    res.json({ ...db.getState(), resumo: db.resumo() });
  });

  router.get('/jogadores', (req, res) => {
    res.json(db.getState().mensalistas);
  });

  router.get('/avulsos', (req, res) => {
    res.json(db.getState().avulsos);
  });

  router.post('/mensalista', (req, res, next) => {
    try {
      const { telefone, nome } = req.body;
      db.addMensalista(telefone, nome);
      res.status(201).json(db.getState().mensalistas);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/mensalista/:telefone', (req, res) => {
    const removed = db.removeMensalista(req.params.telefone);
    res.json({ removed });
  });

  router.post('/acao/nova-semana', (req, res) => {
    res.json(db.novaSemana(req.body.rodada));
  });

  router.post('/acao/convocacao', async (req, res, next) => {
    try {
      await whatsapp.sendGroupMessage(mensagemConvocacao());
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/acao/fechar', async (req, res, next) => {
    try {
      db.setAberto(false);
      db.liberarAvulsos();
      await sheets.syncResumo(db).catch((error) => db.log('Erro ao sincronizar Sheets', { error: error.message }));
      const resumo = formatResumo(db);
      await whatsapp.sendGroupMessage(resumo);
      res.json({ ok: true, resumo: db.resumo() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/acao/abrir', (req, res) => {
    res.json(db.setAberto(true));
  });

  router.post('/acao/resumo', async (req, res, next) => {
    try {
      const resumo = formatResumo(db);
      await whatsapp.sendGroupMessage(resumo);
      res.json({ ok: true, resumo: db.resumo() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/acao/mensagem', async (req, res, next) => {
    try {
      const { mensagem } = req.body;
      if (!mensagem || String(mensagem).trim().length < 2) {
        return res.status(400).json({ error: 'Mensagem obrigatoria.' });
      }
      await whatsapp.sendGroupMessage(String(mensagem).trim());
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createRoutes
};
