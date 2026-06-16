const { google } = require('googleapis');

function sheetsEnabled() {
  return Boolean(
    process.env.GOOGLE_SHEET_ID &&
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY
  );
}

async function getClient() {
  if (!sheetsEnabled()) return null;

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

async function appendRegistro({ data, nome, telefone, tipo, status }) {
  const client = await getClient();
  if (!client) return { skipped: true };

  await client.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[data, nome, telefone, tipo, status]]
    }
  });

  return { ok: true };
}

async function syncResumo(db) {
  const state = db.getState();
  const rows = [
    ...state.mensalistas.map((jogador) => ({
      data: state.rodada,
      nome: jogador.nome,
      telefone: jogador.telefone,
      tipo: 'Mensalista',
      status: jogador.status || 'pendente'
    })),
    ...state.avulsos.map((jogador) => ({
      data: state.rodada,
      nome: jogador.nome,
      telefone: jogador.telefone,
      tipo: 'Avulso',
      status: jogador.status
    }))
  ];

  for (const row of rows) {
    await appendRegistro(row);
  }
}

module.exports = {
  appendRegistro,
  syncResumo,
  sheetsEnabled
};
