const cron = require('node-cron');
const {
  enviarLembretesPendentes,
  formatResumo,
  formatLista,
  mensagemConvocacao
} = require('./handlers');

function startScheduler({ db, whatsapp, sheets }) {
  const timezone = process.env.TIMEZONE || 'America/Sao_Paulo';
  const jobs = [];

  // ── Crons fixos ─────────────────────────────────────────────────────────────

  jobs.push(cron.schedule('0 9 * * 1', async () => {
    try { await whatsapp.sendGroupMessage(mensagemConvocacao()); }
    catch (e) { db.log('Erro cron convocacao', { error: e.message }); }
  }, { timezone }));

  jobs.push(cron.schedule('0 11 * * 2', async () => {
    try { await enviarLembretesPendentes(db, whatsapp); }
    catch (e) { db.log('Erro cron lembrete', { error: e.message }); }
  }, { timezone }));

  jobs.push(cron.schedule('0 12 * * 2', async () => {
    try {
      db.setAberto(false);
      db.liberarAvulsos();
      await sheets.syncResumo(db).catch(e => db.log('Erro Sheets', { error: e.message }));
      await whatsapp.sendGroupMessage(formatResumo(db));
    } catch (e) { db.log('Erro cron fechamento', { error: e.message }); }
  }, { timezone }));

  jobs.push(cron.schedule('0 8 * * 3', async () => {
    try { await whatsapp.sendGroupMessage('⚽ Hoje tem futebol! Boa partida para todos.'); }
    catch (e) { db.log('Erro cron quarta', { error: e.message }); }
  }, { timezone }));

  // ── Executor de agendamentos dinâmicos (a cada minuto) ──────────────────────
  jobs.push(cron.schedule('* * * * *', async () => {
    try {
      const pendentes = db.getAgendamentosParaDisparar();
      for (const ag of pendentes) {
        try {
          await executarAgendamento(ag, db, whatsapp);
          // Único: marca como disparado para não repetir
          if (ag.tipo === 'unico') db.marcarDisparado(ag.id);
          else db.registrarDisparo(ag.id);
          db.log(`Agendamento disparado: ${ag.nome}`);
        } catch (e) {
          db.log(`Erro ao disparar agendamento ${ag.nome}`, { error: e.message });
        }
      }
    } catch (e) {
      db.log('Erro no executor de agendamentos', { error: e.message });
    }
  }, { timezone }));

  db.log('Scheduler iniciado', { timezone, jobs: jobs.length });
  return jobs;
}

async function executarAgendamento(ag, db, whatsapp) {
  // Monta o conteúdo
  let texto = '';
  switch (ag.conteudo) {
    case 'lista':    texto = formatLista(db);   break;
    case 'resumo':   texto = formatResumo(db);  break;
    case 'convocar': texto = mensagemConvocacao(); break;
    default:         texto = ag.mensagem || ''; break;
  }

  if (!texto) return;

  if (ag.destino === 'admins') {
    // Envia privado para cada admin cadastrado
    const admins = db.getAdmins ? db.getAdmins() : [];
    const fromEnv = String(process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean);
    const todos = [...new Set([...admins.map(a => a.telefone), ...fromEnv])];
    for (const tel of todos) {
      if (tel) await whatsapp.sendPrivateMessage(tel, texto).catch(() => {});
    }
  } else {
    await whatsapp.sendGroupMessage(texto, ag.mencionar || false);
  }
}

module.exports = { startScheduler, executarAgendamento };