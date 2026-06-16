const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'estado.json');

function onlyDigits(value = '') {
  return String(value).replace(/\D/g, '');
}

function nextWednesday(from = new Date()) {
  const date = new Date(from);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = (3 - day + 7) % 7 || 7;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

function defaultState() {
  return {
    rodada: nextWednesday(),
    aberto: true,
    mensalistas: [],
    avulsos: [],
    configuracoes: {
      totalVagas: Number(process.env.TOTAL_VAGAS || 20),
      totalMensalistas: Number(process.env.TOTAL_MENSALISTAS || 17),
      valorAvulso: Number(process.env.VALOR_AVULSO || 20)
    },
    logs: []
  };
}

function normalizeState(raw) {
  const state = { ...defaultState(), ...(raw || {}) };
  state.configuracoes = { ...defaultState().configuracoes, ...(raw && raw.configuracoes) };
  state.mensalistas = Array.isArray(state.mensalistas) ? state.mensalistas : [];
  state.avulsos = Array.isArray(state.avulsos) ? state.avulsos : [];
  state.logs = Array.isArray(state.logs) ? state.logs : [];
  return state;
}

class Database {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(this.file)) {
      const state = defaultState();
      fs.writeFileSync(this.file, JSON.stringify(state, null, 2));
      return state;
    }

    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return normalizeState(raw);
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    return this.state;
  }

  getState() {
    return this.state;
  }

  log(message, meta = {}) {
    this.state.logs.unshift({
      at: new Date().toISOString(),
      message,
      meta
    });
    this.state.logs = this.state.logs.slice(0, 100);
    this.save();
  }

  novaSemana(date = nextWednesday()) {
    this.state.rodada = date;
    this.state.aberto = true;
    this.state.mensalistas = this.state.mensalistas.map((jogador) => ({
      ...jogador,
      status: 'pendente'
    }));
    this.state.avulsos = [];
    this.log('Nova semana criada', { rodada: date });
    return this.save();
  }

  setAberto(aberto) {
    this.state.aberto = Boolean(aberto);
    this.log(this.state.aberto ? 'Rodada aberta' : 'Rodada fechada');
    return this.save();
  }

  findMensalista(telefone) {
    const normalized = onlyDigits(telefone);
    return this.state.mensalistas.find((jogador) => onlyDigits(jogador.telefone) === normalized);
  }

  addMensalista(telefone, nome) {
    const normalized = onlyDigits(telefone);
    if (!normalized || !nome) throw new Error('Telefone e nome sao obrigatorios.');
    const existing = this.findMensalista(normalized);
    if (existing) {
      existing.nome = nome.trim();
      existing.status = existing.status || 'pendente';
    } else {
      this.state.mensalistas.push({ telefone: normalized, nome: nome.trim(), status: 'pendente' });
    }
    this.log('Mensalista salvo', { telefone: normalized, nome });
    return this.save();
  }

  removeMensalista(telefone) {
    const normalized = onlyDigits(telefone);
    const before = this.state.mensalistas.length;
    this.state.mensalistas = this.state.mensalistas.filter((jogador) => onlyDigits(jogador.telefone) !== normalized);
    this.log('Mensalista removido', { telefone: normalized });
    this.save();
    return before !== this.state.mensalistas.length;
  }

  confirmarMensalista(telefone, nome, status) {
    if (!['sim', 'nao'].includes(status)) throw new Error('Status invalido.');
    const jogador = this.findMensalista(telefone);
    if (!jogador) return null;
    jogador.nome = jogador.nome || nome || telefone;
    jogador.status = status;
    this.log('Confirmacao registrada', { telefone: jogador.telefone, status });
    return this.save();
  }

  addAvulso(telefone, nome) {
    const normalized = onlyDigits(telefone);
    if (!this.state.aberto) return { ok: false, motivo: 'fechado' };

    const mensalista = this.findMensalista(normalized);
    if (mensalista) return { ok: false, motivo: 'mensalista' };

    const existing = this.state.avulsos.find((jogador) => onlyDigits(jogador.telefone) === normalized);
    if (existing) return { ok: true, jogador: existing, repetido: true };

    const ocupadas = this.totalConfirmados();
    const status = ocupadas < this.state.configuracoes.totalVagas ? 'confirmado' : 'espera';
    const jogador = {
      telefone: normalized,
      nome: (nome || normalized).trim(),
      status,
      criadoEm: new Date().toISOString()
    };
    this.state.avulsos.push(jogador);
    this.log('Avulso entrou na lista', { telefone: normalized, status });
    this.save();
    return { ok: true, jogador, repetido: false };
  }

  totalConfirmados() {
    const mensalistasSim = this.state.mensalistas.filter((jogador) => jogador.status === 'sim').length;
    const avulsosConfirmados = this.state.avulsos.filter((jogador) => jogador.status === 'confirmado').length;
    return mensalistasSim + avulsosConfirmados;
  }

  vagasRestantes() {
    return Math.max(this.state.configuracoes.totalVagas - this.totalConfirmados(), 0);
  }

  liberarAvulsos() {
    let vagas = this.vagasRestantes();
    this.state.avulsos = this.state.avulsos.map((jogador) => {
      if (jogador.status === 'confirmado') return jogador;
      if (vagas > 0) {
        vagas -= 1;
        return { ...jogador, status: 'confirmado' };
      }
      return { ...jogador, status: 'espera' };
    });
    this.log('Vagas liberadas para avulsos');
    return this.save();
  }

  resumo() {
    const confirmados = this.state.mensalistas.filter((jogador) => jogador.status === 'sim');
    const ausentes = this.state.mensalistas.filter((jogador) => jogador.status === 'nao');
    const pendentes = this.state.mensalistas.filter((jogador) => !jogador.status || jogador.status === 'pendente');
    const avulsos = this.state.avulsos.filter((jogador) => jogador.status === 'confirmado');
    const espera = this.state.avulsos.filter((jogador) => jogador.status === 'espera');

    return {
      rodada: this.state.rodada,
      aberto: this.state.aberto,
      confirmados,
      ausentes,
      pendentes,
      avulsos,
      espera,
      vagasRestantes: this.vagasRestantes(),
      totalJogadores: this.totalConfirmados()
    };
  }
}

module.exports = {
  Database,
  onlyDigits,
  nextWednesday
};
