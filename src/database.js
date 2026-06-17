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
          avulsos: []
        };
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