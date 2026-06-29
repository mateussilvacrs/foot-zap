const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, '..', 'data', 'estado.json');

function onlyDigits(val = '') {
  return String(val).replace(/\D/g, '');
}

class Database {
  constructor() {
    if (!fs.existsSync(path.dirname(DATA_FILE))) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    }
    this.load();
  }

  load() {
    this.state = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
      : {
          rodada: new Date().toISOString().slice(0, 10),
          aberto: false,
          pollId: null,
          configuracoes: { totalVagas: 25, valorAvulso: 30 },
          mensalistas: [],
          avulsos: [],
          comandos: [],
          admins: [],
          mensais: [],
          agendamentos: []
        };

    if (!this.state.comandos)     { this.state.comandos     = []; this.save(); }
    if (!this.state.admins)       { this.state.admins       = []; this.save(); }
    if (!this.state.mensais)      { this.state.mensais      = []; this.save(); }
    if (!this.state.agendamentos) { this.state.agendamentos = []; this.save(); }
  }

  save() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2));
  }

  getState() {
    return this.state;
  }

  log(msg, extra = {}) {
    console.log(`[DB] ${msg}`, extra);
  }

  // ─── Resumo ────────────────────────────────────────────────────────────────

  resumo() {
    const mensalistas = this.state.mensalistas || [];
    const confirmados = mensalistas.filter(m => m.status === 'sim');
    const ausentes    = mensalistas.filter(m => m.status === 'nao');
    const pendentes   = mensalistas.filter(m => m.status === 'pendente');
    const avulsos     = (this.state.avulsos || []).filter(a => a.status === 'confirmado');
    const espera      = (this.state.avulsos || []).filter(a => a.status === 'espera');

    const totalOcupado = confirmados.length + avulsos.length;
    const vagasRestantes = Math.max(0, this.state.configuracoes.totalVagas - totalOcupado);

    return {
      rodada: this.state.rodada,
      totalJogadores: totalOcupado,
      confirmados,
      ausentes,
      pendentes,
      avulsos,
      espera,
      vagasRestantes
    };
  }

  // ─── Semana ────────────────────────────────────────────────────────────────

  novaSemana(rodada) {
    this.state.mensalistas.forEach(m => (m.status = 'pendente'));
    this.state.avulsos  = [];
    this.state.aberto   = false;
    this.state.pollId   = null;
    if (rodada) this.state.rodada = rodada;
    this.save();
    return this.resumo();
  }

  // ─── Abertura / Fechamento ─────────────────────────────────────────────────

  setAberto(valor) {
    this.state.aberto = Boolean(valor);
    this.save();
    return { aberto: this.state.aberto };
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────

  setPoll(pollId) {
    this.state.pollId = pollId;
    this.save();
  }

  /**
   * Reseta todos os mensalistas para pendente (chamado quando o admin
   * quer reiniciar a enquete sem criar nova semana).
   */
  resetarEnquete() {
    this.state.mensalistas.forEach(m => (m.status = 'pendente'));
    this.state.avulsos = [];
    this.state.pollId = null;
    this.save();
    return this.resumo();
  }

  // ─── Mensalistas ──────────────────────────────────────────────────────────

  addMensalista(telefone, nome) {
    const tel = onlyDigits(telefone);
    const existe = this.state.mensalistas.find(m => m.telefone === tel);
    if (existe) throw new Error(`Mensalista ${nome} já cadastrado.`);
    this.state.mensalistas.push({ telefone: tel, nome: nome.trim(), status: 'pendente' });
    this.save();
    return this.state.mensalistas;
  }

  removeMensalista(telefone) {
    const tel = onlyDigits(telefone);
    const antes = this.state.mensalistas.length;
    this.state.mensalistas = this.state.mensalistas.filter(m => m.telefone !== tel);
    this.save();
    return this.state.mensalistas.length < antes;
  }

  /**
   * Atualiza status via voto na enquete (chamado pelo webhook do poll).
   * Aceita 'sim' | 'nao' | 'pendente'.
   */
updatePlayerStatus(telefone, status) {
    const tel = onlyDigits(telefone);
    const p = this.state.mensalistas.find(m => m.telefone === tel);
    let promovidos = [];
    
    if (p) {
      p.status = status;
      this.save();
      
      if (status === 'nao') {
        promovidos = this.liberarAvulsos();
      }
      return { success: true, promovidos };
    }
    return { success: false, promovidos: [] };
  }

confirmarMensalista(telefone, nome, status) {
    const tel = onlyDigits(telefone);
    const p = this.state.mensalistas.find(m => m.telefone === tel);
    let promovidos = [];
    
    if (!p) return { jogador: null, promovidos };
    
    p.status = status;
    if (nome) p.nome = nome;
    this.save();
    
    if (status === 'nao') {
      promovidos = this.liberarAvulsos();
    }
    return { jogador: p, promovidos };
  }

  // ─── Avulsos ──────────────────────────────────────────────────────────────

  addAvulso(telefone, nome) {
    const tel = onlyDigits(telefone);

    if (!this.state.aberto) return { motivo: 'fechado' };

    const ehMensalista = this.state.mensalistas.find(m => m.telefone === tel);
    if (ehMensalista) return { motivo: 'mensalista' };

    const jaExiste = this.state.avulsos.find(a => a.telefone === tel);
    if (jaExiste) return { repetido: true, jogador: jaExiste };

    const { confirmados } = this.resumo();
    const avulsosConfirmados = this.state.avulsos.filter(a => a.status === 'confirmado');
    const totalOcupado = confirmados.length + avulsosConfirmados.length;
    const vagasRestantes = this.state.configuracoes.totalVagas - totalOcupado;

    const jogador = {
      telefone: tel,
      nome: nome?.trim() || 'Sem nome',
      status: vagasRestantes > 0 ? 'confirmado' : 'espera'
    };

    this.state.avulsos.push(jogador);
    this.save();
    return { jogador };
  }

  /**
   * Remove um avulso da lista (confirmado ou espera) e, se ele estava confirmado,
   * promove automaticamente o primeiro da fila de espera.
   * Retorna { removido, promovido } onde promovido pode ser null.
   */
  desistirAvulso(telefone) {
    const tel = onlyDigits(telefone);
    const idx = this.state.avulsos.findIndex(a => a.telefone === tel);
    if (idx === -1) return { removido: false, promovido: null };

    const [jogador] = this.state.avulsos.splice(idx, 1);
    let promovido = null;

    // Se ele estava confirmado, abre uma vaga → promover primeiro da espera
    if (jogador.status === 'confirmado') {
      const proxEspera = this.state.avulsos.find(a => a.status === 'espera');
      if (proxEspera) {
        proxEspera.status = 'confirmado';
        promovido = proxEspera;
      }
    }

    this.save();
    return { removido: true, jogador, promovido };
  }

  // ─── Comandos personalizados ───────────────────────────────────────────────

  /**
   * Cada comando: { id, gatilho, descricao, tipo, resposta, ativo }
   * tipo: 'mensagem' | 'lista' | 'resumo'
   */
  getComandos() {
    return this.state.comandos || [];
  }

  addComando({ gatilho, descricao, tipo, resposta, contadorConfig }) {
    const gatilhoNorm = gatilho.startsWith('/') ? gatilho.toLowerCase() : `/${gatilho.toLowerCase()}`;

    const existe = this.state.comandos.find(c => c.gatilho === gatilhoNorm);
    if (existe) throw new Error(`Comando ${gatilhoNorm} já existe.`);

    const novo = {
      id: Date.now().toString(),
      gatilho: gatilhoNorm,
      descricao: descricao || '',
      tipo: tipo || 'mensagem',   // 'mensagem' | 'lista' | 'resumo' | 'contador'
      resposta: resposta || '',
      ativo: true
    };

    if (tipo === 'contador') {
      const templateDigitado = (contadorConfig?.template || '').trim();
      novo.contadorConfig = {
        template: templateDigitado || '{nome} pediu {faltas} faltas em apenas {jogos} jogos',
        nome: contadorConfig?.nome || '',
        incrementoPor: Number(contadorConfig?.incrementoPor) || 1,
        ciclo: Number(contadorConfig?.ciclo) || 12,
      };
      novo.contadorValor = 0;
      novo.contadorJogos = 1;
    }

    this.state.comandos.push(novo);
    this.save();
    return novo;
  }

  /**
   * Incrementa o contador de um comando do tipo 'contador'.
   * Retorna { cmd, faltas, jogos, mensagem } após o incremento.
   */
  incrementarContador(id) {
    const cmd = this.state.comandos.find(c => c.id === id);
    if (!cmd || cmd.tipo !== 'contador') return null;

    const cfg = cmd.contadorConfig || {};
    const incremento = Number(cfg.incrementoPor) || 1;
    const ciclo      = Number(cfg.ciclo) || 12;

    cmd.contadorValor = (Number(cmd.contadorValor) || 0) + incremento;
    cmd.contadorJogos = Math.floor((cmd.contadorValor - 1) / ciclo) + 1;

    const template = cfg.template || '{nome} pediu {faltas} falta(s) em apenas {jogos} jogo(s)';
    const nome     = cfg.nome || '';

    const mensagem = template
      .replace(/\{nome\}/g,   nome)
      .replace(/\{faltas\}/g, String(cmd.contadorValor))
      .replace(/\{jogos\}/g,  String(cmd.contadorJogos));

    this.save();

    console.log('[CONTADOR]', { id, template, nome, faltas: cmd.contadorValor, jogos: cmd.contadorJogos, mensagem });

    return { cmd, faltas: cmd.contadorValor, jogos: cmd.contadorJogos, mensagem };
  }

  /**
   * Reseta o contador de um comando.
   */
  resetarContador(id) {
    const cmd = this.state.comandos.find(c => c.id === id);
    if (!cmd || cmd.tipo !== 'contador') return null;
    cmd.contadorValor = 0;
    cmd.contadorJogos = 1;
    this.save();
    return cmd;
  }

  updateComando(id, campos) {
    const cmd = this.state.comandos.find(c => c.id === id);
    if (!cmd) return null;
    Object.assign(cmd, campos);
    this.save();
    return cmd;
  }

  removeComando(id) {
    const antes = this.state.comandos.length;
    this.state.comandos = this.state.comandos.filter(c => c.id !== id);
    this.save();
    return this.state.comandos.length < antes;
  }

  findComando(gatilho) {
    const g = gatilho.toLowerCase();
    return this.state.comandos.find(c => c.ativo && c.gatilho === g) || null;
  }

  // ─── Admins dinâmicos ─────────────────────────────────────────────────────

  getAdmins() {
    return this.state.admins || [];
  }

  addAdmin(telefone, nome) {
    if (!this.state.admins) this.state.admins = [];
    const tel = onlyDigits(telefone);
    if (!tel) throw new Error('Telefone inválido.');
    const existe = this.state.admins.find(a => a.telefone === tel);
    if (existe) throw new Error(`${tel} já é administrador.`);
    const admin = { telefone: tel, nome: (nome || '').trim(), criadoEm: new Date().toISOString() };
    this.state.admins.push(admin);
    this.save();
    return admin;
  }

  removeAdmin(telefone) {
    const tel = onlyDigits(telefone);
    const antes = (this.state.admins || []).length;
    this.state.admins = (this.state.admins || []).filter(a => a.telefone !== tel);
    this.save();
    return this.state.admins.length < antes;
  }

  // ─── Mensais (cadastro/pagamento) ─────────────────────────────────────────
  /**
   * Cadastro separado dos mensalistas da rodada.
   * statusCadastro: 'aguardando' | 'aprovado' | 'inativo'
   * Ao aprovar, o jogador é inserido em mensalistas[] como 'pendente'.
   */

  getMensais() {
    return this.state.mensais || [];
  }

  addMensal(telefone, nome, obs, validade) {
    if (!this.state.mensais) this.state.mensais = [];
    const tel = onlyDigits(telefone);
    if (!tel || !nome) throw new Error('Telefone e nome são obrigatórios.');
    const existe = this.state.mensais.find(m => m.telefone === tel);
    if (existe) throw new Error(`Jogador ${nome} já está no cadastro de mensais.`);
    const mensal = {
      id: Date.now().toString(),
      telefone: tel,
      nome: nome.trim(),
      obs: (obs || '').trim(),
      validade: validade || null,   // data de validade da mensalidade (AAAA-MM-DD)
      statusCadastro: 'aguardando', // aguardando | aprovado | inativo
      criadoEm: new Date().toISOString(),
      aprovadoEm: null
    };
    this.state.mensais.push(mensal);
    this.save();
    return mensal;
  }

  updateMensal(id, campos) {
    const m = (this.state.mensais || []).find(m => m.id === id);
    if (!m) return null;
    Object.assign(m, campos);
    this.save();
    return m;
  }

  removeMensal(id) {
    const antes = (this.state.mensais || []).length;
    this.state.mensais = (this.state.mensais || []).filter(m => m.id !== id);
    this.save();
    return (this.state.mensais || []).length < antes;
  }

  /**
   * Aprova o pagamento: marca statusCadastro='aprovado' e,
   * se ainda não for mensalista, adiciona em mensalistas[] como pendente.
   * Retorna { mensal, jaEraMensalista }
   */
  aprovarMensal(id) {
    const m = (this.state.mensais || []).find(m => m.id === id);
    if (!m) throw new Error('Cadastro não encontrado.');

    m.statusCadastro = 'aprovado';
    m.aprovadoEm = new Date().toISOString();

    const jaExiste = this.state.mensalistas.find(ms => ms.telefone === m.telefone);
    if (!jaExiste) {
      this.state.mensalistas.push({ telefone: m.telefone, nome: m.nome, status: 'pendente' });
    } else {
      // Garante que o nome está atualizado
      jaExiste.nome = m.nome;
    }

    this.save();
    return { mensal: m, jaEraMensalista: Boolean(jaExiste) };
  }

  /**
   * Remove aprovação: marca statusCadastro='inativo' e
   * opcionalmente remove de mensalistas[] se ainda estiver pendente.
   */
  revogarMensal(id) {
    const m = (this.state.mensais || []).find(m => m.id === id);
    if (!m) throw new Error('Cadastro não encontrado.');

    m.statusCadastro = 'inativo';
    // Remove de mensalistas somente se ainda pendente (não jogou nenhuma rodada)
    this.state.mensalistas = this.state.mensalistas.filter(
      ms => !(ms.telefone === m.telefone && ms.status === 'pendente')
    );

    this.save();
    return m;
  }

  /**
   * Move avulsos da fila de espera para confirmado ao fechar a rodada.
   */
liberarAvulsos() {
    const { configuracoes, mensalistas, avulsos } = this.state;
    const confirmadosMensalistas = mensalistas.filter(m => m.status === 'sim').length;
    let slots = configuracoes.totalVagas - confirmadosMensalistas;
    const promovidos = []; // Guarda quem saiu da espera

    for (const a of avulsos) {
      if (a.status === 'confirmado') { slots--; continue; }
      if (a.status === 'espera' && slots > 0) { 
        a.status = 'confirmado'; 
        slots--; 
        promovidos.push(a); // Adiciona na lista de notificação
      }
    }
    this.save();
    return promovidos;
  }

  // ─── Agendamentos ──────────────────────────────────────────────────────────
  //
  // Cada agendamento:
  // {
  //   id, ativo, nome,
  //   tipo: 'unico' | 'recorrente',
  //
  //   -- único: dispara uma vez numa data/hora específica
  //   dataHora: '2026-06-30T09:00',   // ISO local
  //   disparado: false,
  //
  //   -- recorrente: expressão cron simplificada via campos
  //   diasSemana: [1,3,5],            // 0=dom … 6=sab
  //   hora: '09:00',
  //
  //   -- conteúdo
  //   conteudo: 'mensagem livre' | 'lista' | 'resumo' | 'convocar',
  //   mensagem: 'texto...',           // só para conteudo='mensagem livre'
  //   mencionar: false,               // @todos
  //   destino: 'grupo' | 'admins',    // admins = mensagem privada p/ cada admin
  // }

  getAgendamentos() {
    return this.state.agendamentos || [];
  }

  addAgendamento(dados) {
    const ag = {
      id: Date.now().toString(),
      ativo: true,
      nome: dados.nome || 'Sem nome',
      tipo: dados.tipo || 'recorrente',       // 'unico' | 'recorrente'
      // único
      dataHora: dados.dataHora || null,
      disparado: false,
      // recorrente
      diasSemana: dados.diasSemana || [],     // array de 0-6
      hora: dados.hora || '09:00',
      // conteúdo
      conteudo: dados.conteudo || 'mensagem livre',
      mensagem: dados.mensagem || '',
      mencionar: Boolean(dados.mencionar),
      destino: dados.destino || 'grupo',
      criadoEm: new Date().toISOString()
    };
    this.state.agendamentos.push(ag);
    this.save();
    return ag;
  }

  updateAgendamento(id, campos) {
    const ag = this.state.agendamentos.find(a => a.id === id);
    if (!ag) return null;
    Object.assign(ag, campos);
    this.save();
    return ag;
  }

  removeAgendamento(id) {
    const antes = this.state.agendamentos.length;
    this.state.agendamentos = this.state.agendamentos.filter(a => a.id !== id);
    this.save();
    return this.state.agendamentos.length < antes;
  }

  // Retorna agendamentos recorrentes que devem disparar agora
  // (chamado a cada minuto pelo scheduler)
  getAgendamentosParaDisparar() {
    const agora  = new Date();
    const hora   = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}`;
    const diaSem = agora.getDay(); // 0=dom
    const isoNow = agora.toISOString().slice(0,16); // 'YYYY-MM-DDTHH:MM'

    return this.state.agendamentos.filter(ag => {
      if (!ag.ativo) return false;
      if (ag.tipo === 'unico') {
        // Dispara se ainda não foi disparado e o horário chegou
        return !ag.disparado && ag.dataHora && ag.dataHora <= isoNow;
      }
      // Recorrente: dia da semana e hora batem
      return ag.diasSemana.includes(diaSem) && ag.hora === hora;
    });
  }

  marcarDisparado(id) {
    const ag = this.state.agendamentos.find(a => a.id === id);
    if (ag) { ag.disparado = true; ag.ultimoDisparo = new Date().toISOString(); this.save(); }
  }

  registrarDisparo(id) {
    const ag = this.state.agendamentos.find(a => a.id === id);
    if (ag) { ag.ultimoDisparo = new Date().toISOString(); this.save(); }
  }
}

module.exports = { Database, onlyDigits };