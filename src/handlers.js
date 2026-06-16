const { onlyDigits } = require('./database');

function adminNumbers() {
  return String(process.env.ADMIN_NUMBERS || '')
    .split(',')
    .map(onlyDigits)
    .filter(Boolean);
}

function numberedList(items) {
  if (!items.length) return '- nenhum';
  return items.map((item, index) => `${index + 1} ${item.nome}`).join('\n');
}

function formatResumo(db) {
  const resumo = db.resumo();
  return [
    '⚽ RESUMO DA SEMANA',
    '',
    'Confirmados:',
    numberedList(resumo.confirmados),
    '',
    'Ausentes:',
    numberedList(resumo.ausentes),
    '',
    'Avulsos:',
    numberedList(resumo.avulsos),
    '',
    resumo.espera.length ? `Fila de espera:\n${numberedList(resumo.espera)}\n` : null,
    `Vagas restantes: ${resumo.vagasRestantes}`
  ]
    .filter(Boolean)
    .join('\n');
}

function formatLista(db) {
  const resumo = db.resumo();
  return [
    `⚽ LISTA DA RODADA ${resumo.rodada}`,
    '',
    'Mensalistas confirmados:',
    numberedList(resumo.confirmados),
    '',
    'Avulsos:',
    numberedList(resumo.avulsos),
    '',
    `Vagas restantes: ${resumo.vagasRestantes}`
  ].join('\n');
}

function mensagemConvocacao() {
  return [
    '⚽ CONFIRMAÇÃO FUTEBOL DE QUARTA',
    'Mensalistas, confirmem presença:',
    '/confirmar sim',
    '/confirmar nao',
    '',
    'Quem não for mensalista pode entrar na fila:',
    '/querojogar'
  ].join('\n');
}

function mensagemAjuda(isAdmin = false) {
  const base = [
    '⚽ Comandos do Futebol Bot',
    'Mensalistas: /confirmar sim',
    'Mensalistas: /confirmar nao',
    'Avulsos: /querojogar',
    '/lista',
    '/ajuda'
  ];

  if (isAdmin) {
    base.push(
      '',
      'Admin privado:',
      '/admin nova-semana',
      '/admin convocar',
      '/admin fechar',
      '/admin abrir',
      '/admin resumo',
      '/admin add-mensalista telefone nome',
      '/admin rm-mensalista telefone'
    );
  }

  return base.join('\n');
}

async function enviarLembretesPendentes(db, whatsapp) {
  const pendentes = db.resumo().pendentes;
  for (const jogador of pendentes) {
    await whatsapp.sendPrivateMessage(
      jogador.telefone,
      `⚽ Oi, ${jogador.nome}! Confirme o futebol desta semana com /confirmar sim ou /confirmar nao.`
    );
  }
  db.log('Lembretes enviados', { total: pendentes.length });
  return pendentes.length;
}

async function handleAdmin(command, context, services) {
  const { db, whatsapp, sheets } = services;
  const isAdmin = adminNumbers().includes(onlyDigits(context.telefone));
  if (!isAdmin) return 'Comando restrito aos administradores.';
  if (context.isGroup) return 'Por segurança, comandos admin devem ser enviados no privado do bot.';

  const args = command.split(/\s+/).slice(1);
  const action = (args.shift() || '').toLowerCase();

  if (action === 'nova-semana') {
    db.novaSemana();
    return `Nova semana criada para ${db.getState().rodada}.`;
  }

  if (action === 'convocar') {
    await whatsapp.sendGroupMessage(mensagemConvocacao());
    return 'Convocação enviada no grupo.';
  }

  if (action === 'fechar') {
    db.setAberto(false);
    db.liberarAvulsos();
    await sheets.syncResumo(db).catch((error) => db.log('Erro ao sincronizar Sheets', { error: error.message }));
    const resumo = formatResumo(db);
    await whatsapp.sendGroupMessage(resumo);
    return 'Rodada fechada e resumo enviado.';
  }

  if (action === 'abrir') {
    db.setAberto(true);
    return 'Rodada aberta.';
  }

  if (action === 'resumo') return formatResumo(db);

  if (action === 'add-mensalista') {
    const telefone = args.shift();
    const nome = args.join(' ').trim();
    db.addMensalista(telefone, nome);
    return `Mensalista ${nome} salvo.`;
  }

  if (action === 'rm-mensalista') {
    const telefone = args.shift();
    const removed = db.removeMensalista(telefone);
    return removed ? 'Mensalista removido.' : 'Mensalista nao encontrado.';
  }

  return mensagemAjuda(true);
}

async function handleCommand(context, services) {
  const { db, sheets } = services;
  const text = String(context.text || '').trim();
  const lower = text.toLowerCase();
  const isAdmin = adminNumbers().includes(onlyDigits(context.telefone));

  if (!lower.startsWith('/')) return null;

  if (lower.startsWith('/admin')) {
    return handleAdmin(text, context, services);
  }

  if (lower === '/ajuda') return mensagemAjuda(isAdmin);
  if (lower === '/lista') return formatLista(db);

  if (lower.startsWith('/confirmar') || lower.startsWith('/confirma')) {
    const parts = lower.split(/\s+/);
    const status = parts[1] === 'não' ? 'nao' : parts[1];
    if (!['sim', 'nao'].includes(status)) return 'Use /confirmar sim ou /confirmar nao.';

    const state = db.confirmarMensalista(context.telefone, context.nome, status);
    if (!state) return 'Não encontrei você como mensalista. Se quiser entrar como avulso, use /querojogar.';

    await sheets
      .appendRegistro({
        data: db.getState().rodada,
        nome: context.nome,
        telefone: context.telefone,
        tipo: 'Mensalista',
        status
      })
      .catch((error) => db.log('Erro ao registrar Sheets', { error: error.message }));

    return status === 'sim'
      ? 'Presença confirmada. Bom jogo! ⚽'
      : 'Ausência registrada. Valeu por avisar!';
  }

  if (lower === '/querojogar') {
    const result = db.addAvulso(context.telefone, context.nome);
    if (result.motivo === 'fechado') return 'A rodada está fechada no momento.';
    if (result.motivo === 'mensalista') return 'Você é mensalista. Confirme com /confirmar sim ou /confirmar nao.';
    if (result.repetido) return `Você já está na lista como ${result.jogador.status}.`;

    await sheets
      .appendRegistro({
        data: db.getState().rodada,
        nome: result.jogador.nome,
        telefone: result.jogador.telefone,
        tipo: 'Avulso',
        status: result.jogador.status
      })
      .catch((error) => db.log('Erro ao registrar Sheets', { error: error.message }));

    return result.jogador.status === 'confirmado'
      ? 'Você entrou na lista de avulsos. Valor: R$ ' + db.getState().configuracoes.valorAvulso
      : 'Lista cheia ⚽ você entrou na fila de espera.';
  }

  return 'Comando não reconhecido. Use /ajuda para ver as opções.';
}

module.exports = {
  handleCommand,
  handleAdmin,
  enviarLembretesPendentes,
  formatResumo,
  formatLista,
  mensagemConvocacao
};
