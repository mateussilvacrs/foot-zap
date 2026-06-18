const { onlyDigits } = require('./database');

function adminNumbers(db) {
  const fromEnv = String(process.env.ADMIN_NUMBERS || '')
    .split(',').map(onlyDigits).filter(Boolean);
  const fromDb = db ? (db.getAdmins() || []).map(a => a.telefone) : [];
  return [...new Set([...fromEnv, ...fromDb])];
}

function numberedList(items) {
  if (!items || !items.length) return '- nenhum';
  return items.map((item, i) => `${i + 1}. ${item.nome}`).join('\n');
}

function formatResumo(db) {
  const r = db.resumo();
  const linhas = [
    '⚽ RESUMO DA SEMANA',
    `Rodada: ${r.rodada}`,
    '',
    `✅ Confirmados (${r.confirmados.length}):`,
    numberedList(r.confirmados),
    '',
    `❌ Ausentes (${r.ausentes.length}):`,
    numberedList(r.ausentes),
    '',
    `⏳ Pendentes (${r.pendentes.length}):`,
    numberedList(r.pendentes),
    '',
    `🔓 Avulsos (${r.avulsos.length}):`,
    numberedList(r.avulsos)
  ];

  if (r.espera && r.espera.length) {
    linhas.push('', `🕐 Fila de espera (${r.espera.length}):`, numberedList(r.espera));
  }

  linhas.push('', `Vagas restantes: ${r.vagasRestantes}`);
  return linhas.join('\n');
}

function formatLista(db) {
  const r = db.resumo();
  return [
    `⚽ LISTA DA RODADA ${r.rodada}`,
    '',
    `Mensalistas confirmados (${r.confirmados.length}):`,
    numberedList(r.confirmados),
    '',
    `Avulsos (${r.avulsos.length}):`,
    numberedList(r.avulsos),
    '',
    `Vagas restantes: ${r.vagasRestantes}`

        `Ordem da Lista de espera (${r.espera.length}):`,
    numberedList(r.espera),
    '',
  ].join('\n');
}

function formatMensais(db, mostrarValidade = true) {
  const mensais = db.getMensais();
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

  const aprovados = mensais.filter(m => m.statusCadastro === 'aprovado');
  const pendentes = mensais.filter(m => m.statusCadastro === 'aguardando');

  // Aprovados com validade vencida são destacados (só relevante quando mostrando validade)
  const aprovadosAtivos   = mostrarValidade
    ? aprovados.filter(m => !m.validade || new Date(m.validade) >= hoje)
    : aprovados;
  const aprovadosVencidos = mostrarValidade
    ? aprovados.filter(m => m.validade && new Date(m.validade) < hoje)
    : [];

  const linhas = ['💳 MENSALISTAS', ''];

  if (aprovadosAtivos.length) {
    linhas.push(`✅ Pagos e ativos (${aprovadosAtivos.length}):`);
    aprovadosAtivos.forEach((m, i) => {
      const val = mostrarValidade && m.validade
        ? ` (válido até ${new Date(m.validade + 'T12:00:00').toLocaleDateString('pt-BR')})`
        : '';
      linhas.push(`${i + 1}. ${m.nome}${val}`);
    });
    linhas.push('');
  }

  if (mostrarValidade && aprovadosVencidos.length) {
    linhas.push(`⚠️ Mensalidade vencida (${aprovadosVencidos.length}):`);
    aprovadosVencidos.forEach((m, i) => {
      const val = m.validade
        ? ` (venceu em ${new Date(m.validade + 'T12:00:00').toLocaleDateString('pt-BR')})`
        : '';
      linhas.push(`${i + 1}. ${m.nome}${val}`);
    });
    linhas.push('');
  }

  if (pendentes.length) {
    linhas.push(`⏳ Aguardando pagamento (${pendentes.length}):`);
    pendentes.forEach((m, i) => linhas.push(`${i + 1}. ${m.nome}`));
    linhas.push('');
  }

  if (!aprovadosAtivos.length && !aprovadosVencidos.length && !pendentes.length) {
    linhas.push('Nenhum mensalista cadastrado.');
  }

  return linhas.join('\n').trim();
}

function mensagemConvocacao(){
  return [
    '⚽ CONFIRMAÇÃO FUTEBOL DE QUARTA',
    'Mensalistas, confirmem presença respondendo a enquete ou pelo chat:',
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
    '/confirmar sim  – Confirmar presença (mensalistas)',
    '/confirmar nao  – Registrar ausência (mensalistas)',
    '/querojogar      – Entrar como avulso',
    '/desistir        – Desistir (avulsos)',
    '/lista           – Ver lista da rodada',
    '/ajuda           – Ver esta mensagem'
  ];

  if (isAdmin) {
    base.push(
      '',
      '🔧 Admin (somente privado):',
      '/admin nova-semana [AAAA-MM-DD]',
      '/admin convocar',
      '/admin fechar',
      '/admin abrir',
      '/admin resumo',
      '/admin lembrar',
      '/admin add-mensalista <telefone> <nome>',
      '/admin rm-mensalista <telefone>',
      '/mensais              – Ver status de pagamentos (com validade)',
      '/mensais1             – Ver lista de mensalistas (sem validade)'
    );
  }

  return base.join('\n');
}

async function enviarLembretesPendentes(db, whatsapp) {
  const pendentes = db.resumo().pendentes;
  for (const jogador of pendentes) {
    await whatsapp.sendPrivateMessage(
      jogador.telefone,
      `⚽ Oi, ${jogador.nome}! Confirme o futebol desta semana:\n/confirmar sim\n/confirmar nao`
    );
  }
  db.log('Lembretes enviados', { total: pendentes.length });
  return pendentes.length;
}

async function handleAdmin(command, context, services) {
  const { db, whatsapp, sheets } = services;
  const isAdmin = adminNumbers(db).includes(onlyDigits(context.telefone));
  if (!isAdmin) return 'Comando restrito aos administradores.';
  if (context.isGroup) return 'Por segurança, comandos admin devem ser enviados no privado do bot.';

  const args = command.trim().split(/\s+/).slice(1); // remove "/admin"
  const action = (args.shift() || '').toLowerCase();

  if (action === 'nova-semana') {
    const rodada = args[0] || null;
    db.novaSemana(rodada);
    return `Nova semana criada. Rodada: ${db.getState().rodada}.`;
  }

  if (action === 'convocar') {
    const result = await whatsapp.sendGroupMessage(mensagemConvocacao());
    return 'Convocação enviada no grupo.';
  }

  if (action === 'fechar') {
    db.setAberto(false);
    db.liberarAvulsos();
    if (sheets) {
      await sheets.syncResumo(db).catch(e => db.log('Erro Sheets', { error: e.message }));
    }
    await whatsapp.sendGroupMessage(formatResumo(db));
    return 'Rodada fechada e resumo enviado.';
  }

  if (action === 'abrir') {
    db.setAberto(true);
    return 'Rodada aberta. Avulsos podem se inscrever com /querojogar.';
  }

  if (action === 'resumo') {
    return formatResumo(db);
  }

  if (action === 'lembrar') {
    const total = await enviarLembretesPendentes(db, whatsapp);
    return `Lembretes enviados para ${total} jogador(es) pendente(s).`;
  }

  if (action === 'add-mensalista') {
    const telefone = args.shift();
    const nome = args.join(' ').trim();
    if (!telefone || !nome) return 'Uso: /admin add-mensalista <telefone> <nome>';
    try {
      db.addMensalista(telefone, nome);
      return `✅ Mensalista ${nome} cadastrado com sucesso.`;
    } catch (e) {
      return `Erro: ${e.message}`;
    }
  }

  if (action === 'rm-mensalista') {
    const telefone = args.shift();
    if (!telefone) return 'Uso: /admin rm-mensalista <telefone>';
    const removed = db.removeMensalista(telefone);
    return removed ? 'Mensalista removido.' : 'Mensalista não encontrado.';
  }

  return mensagemAjuda(true);
}

async function handleCommand(context, services) {
  const { db, sheets, whatsapp } = services;
  const text = String(context.text || '').trim();
  const lower = text.toLowerCase();
  const isAdmin = adminNumbers(db).includes(onlyDigits(context.telefone));

  if (!lower.startsWith('/')) return null;

  if (lower.startsWith('/admin')) {
    return handleAdmin(text, context, services);
  }

  if (lower === '/ajuda') {
    const base = mensagemAjuda(isAdmin);
    const customAtivos = db.getComandos().filter(c => c.ativo);
    if (!customAtivos.length) return base;
    const extras = customAtivos.map(c => `${c.gatilho}  – ${c.descricao || c.tipo}`).join('\n');
    return base + '\n\nComandos extras:\n' + extras;
  }
  if (lower === '/mensais') {
    if (!isAdmin) {
      // Debug: mostra qual número chegou vs. admins configurados
      const admins = adminNumbers(db);
      const tel = onlyDigits(context.telefone);
      console.warn('[DEBUG /mensais] telefone recebido:', tel, '| admins:', admins);
      return 'Comando restrito aos administradores.';
    }
    return formatMensais(db, true);
  }
  if (lower === '/mensais1') {
    // Lista sem validade: pública, pode ser usada no grupo por qualquer um
    return formatMensais(db, false);
  }
  if (lower === '/lista') return formatLista(db);

  if (lower.startsWith('/confirmar') || lower.startsWith('/confirma')) {
    const parts = lower.split(/\s+/);
    const rawStatus = (parts[1] || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const status = rawStatus === 'nao' || rawStatus === 'não' ? 'nao' : rawStatus;

    if (!['sim', 'nao'].includes(status)) {
      return 'Use /confirmar sim ou /confirmar nao.';
    }

    const jogador = db.confirmarMensalista(context.telefone, context.nome, status);
    if (!jogador) {
      return 'Não encontrei você como mensalista. Se quiser entrar como avulso, use /querojogar.';
    }

    if (sheets) {
      await sheets.appendRegistro({
        data: db.getState().rodada,
        nome: jogador.nome,
        telefone: jogador.telefone,
        tipo: 'Mensalista',
        status
      }).catch(e => db.log('Erro Sheets', { error: e.message }));
    }

    return status === 'sim'
      ? `✅ Presença confirmada. Bom jogo, ${jogador.nome}! ⚽`
      : `👍 Ausência registrada. Valeu por avisar, ${jogador.nome}!`;
  }

  if (lower === '/desistir') {
    const { removido, jogador, promovido } = db.desistirAvulso(context.telefone);
    if (!removido) {
      return 'Você não está na lista de avulsos nem na fila de espera.';
    }

    // Notifica o promovido da fila de espera via mensagem privada
    if (promovido) {
      const valor = db.getState().configuracoes.valorAvulso;
      await whatsapp.sendPrivateMessage(
        promovido.telefone,
        `⚽ Boa notícia, ${promovido.nome}! Uma vaga abriu e você saiu da fila de espera.\nVocê está confirmado para o jogo desta semana! Valor: R$ ${valor} ⚽`
      ).catch(e => db.log('Erro ao notificar promovido', { error: e.message }));
    }

    return jogador.status === 'espera'
      ? `👍 Ok, ${jogador.nome}. Você saiu da fila de espera.`
      : `👍 Desistência registrada, ${jogador.nome}. Até a próxima!${promovido ? `\n(${promovido.nome} foi promovido da fila de espera 🎉)` : ''}`;
  }

  if (lower === '/querojogar') {
    const result = db.addAvulso(context.telefone, context.nome);
    if (result.motivo === 'fechado') return 'A rodada está fechada no momento.';
    if (result.motivo === 'mensalista') return 'Você é mensalista. Confirme com /confirmar sim ou /confirmar nao.';
    if (result.repetido) {
      const status = result.jogador.status === 'espera' ? 'na fila de espera' : 'na lista de avulsos';
      return `Você já está ${status}.`;
    }

    if (sheets) {
      await sheets.appendRegistro({
        data: db.getState().rodada,
        nome: result.jogador.nome,
        telefone: result.jogador.telefone,
        tipo: 'Avulso',
        status: result.jogador.status
      }).catch(e => db.log('Erro Sheets', { error: e.message }));
    }

    const valor = db.getState().configuracoes.valorAvulso;
    return result.jogador.status === 'confirmado'
      ? `✅ Você entrou na lista de avulsos. Valor: R$ ${valor} ⚽`
      : '⏳ Lista cheia — você entrou na fila de espera.';
  }

  // ── Comandos personalizados criados pelo admin ───────────────────────────
  const cmdCustom = db.findComando(lower.split(/\s+/)[0]);
  if (cmdCustom) {
    // Verifica permissão
    if (cmdCustom.permissao === 'admin' && !isAdmin) {
      return 'Esse comando é restrito aos administradores.';
    }
    // Verifica escopo
    const escopo = cmdCustom.escopo || 'ambos';
    if (escopo === 'grupo' && !context.isGroup) return 'Esse comando só funciona no grupo.';
    if (escopo === 'privado' && context.isGroup) return 'Esse comando só funciona no privado do bot.';

    if (cmdCustom.tipo === 'lista')  return formatLista(db);
    if (cmdCustom.tipo === 'resumo') return formatResumo(db);
    if (cmdCustom.tipo === 'contador') {
      const resultado = db.incrementarContador(cmdCustom.id);
      return resultado ? resultado.mensagem : '(erro no contador)';
    }
    return cmdCustom.resposta || '(sem resposta configurada)';
  }

  return 'Comando não reconhecido. Use /ajuda para ver as opções.';
}

module.exports = {
  handleCommand,
  handleAdmin,
  enviarLembretesPendentes,
  formatResumo,
  formatLista,
  formatMensais,
  mensagemConvocacao
};