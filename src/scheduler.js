const cron = require('node-cron');
const {
  enviarLembretesPendentes,
  formatResumo,
  mensagemConvocacao
} = require('./handlers');

function startScheduler({ db, whatsapp, sheets }) {
  const timezone = process.env.TIMEZONE || 'America/Sao_Paulo';
  const jobs = [];

  jobs.push(
    cron.schedule(
      '0 9 * * 1',
      async () => {
        try {
        //  db.novaSemana();
          await whatsapp.sendGroupMessage(mensagemConvocacao());
        } catch (error) {
          db.log('Erro no cron de convocacao', { error: error.message });
        }
      },
      { timezone }
    )
  );

  jobs.push(
    cron.schedule(
      '0 11 * * 2',
      async () => {
        try {
          await enviarLembretesPendentes(db, whatsapp);
        } catch (error) {
          db.log('Erro no cron de lembrete', { error: error.message });
        }
      },
      { timezone }
    )
  );

  jobs.push(
    cron.schedule(
      '0 12 * * 2',
      async () => {
        try {
          db.setAberto(false);
          db.liberarAvulsos();
          await sheets.syncResumo(db).catch((error) => db.log('Erro ao sincronizar Sheets', { error: error.message }));
          await whatsapp.sendGroupMessage(formatResumo(db));
        } catch (error) {
          db.log('Erro no cron de fechamento', { error: error.message });
        }
      },
      { timezone }
    )
  );

  jobs.push(
    cron.schedule(
      '0 8 * * 3',
      async () => {
        try {
          await whatsapp.sendGroupMessage('⚽ Hoje tem futebol! Boa partida para todos.');
        } catch (error) {
          db.log('Erro no cron de quarta-feira', { error: error.message });
        }
      },
      { timezone }
    )
  );

  db.log('Scheduler iniciado', { timezone, jobs: jobs.length });
  return jobs;
}

module.exports = {
  startScheduler
};