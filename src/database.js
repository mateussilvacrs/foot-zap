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
          comandos: [],   // comandos personalizados criados pelo admin
          admins: []      // admins dinâmicos além dos do .env
        };

    // Garante que versões antigas do estado.json tenham os campos
    if (!this.state.comandos) { this.state.comandos = []; this.save(); }
    if (!this.state.admins)   { this.state.admins = [];   this.save(); }
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
    if (p) {
      p.status = status;
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Confirmação via comando de texto /confirmar sim|nao.
   */
  confirmarMensalista(telefone, nome, status) {
    const tel = onlyDigits(telefone);
    const p = this.state.mensalistas.find(m => m.telefone === tel);
    if (!p) return null;
    p.status = status;
    if (nome) p.nome = nome;
    this.save();
    return p;
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

  // ─── Admins dinâmicos ─────────────────────────────────────────────────────

  /**
   * Retorna todos os admins cadastrados no banco.
   * Os do .env (ADMIN_NUMBERS) são gerenciados separadamente pelo handlers.
   */
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

  findComando(gatilho) {
    const g = gatilho.toLowerCase();
    return this.state.comandos.find(c => c.ativo && c.gatilho === g) || null;
  }

  /**
   * Move avulsos da fila de espera para confirmado ao fechar a rodada.
   */
  liberarAvulsos() {
    const { configuracoes, mensalistas, avulsos } = this.state;
    const confirmadosMensalistas = mensalistas.filter(m => m.status === 'sim').length;
    let slots = configuracoes.totalVagas - confirmadosMensalistas;

    for (const a of avulsos) {
      if (a.status === 'confirmado') { slots--; continue; }
      if (a.status === 'espera' && slots > 0) { a.status = 'confirmado'; slots--; }
    }
    this.save();
  }
}

module.exports = { Database, onlyDigits };