const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, '..', 'data', 'estado.json');

function onlyDigits(val = '') { 
  return String(val).replace(/\D/g, ''); 
}

class Database {
  constructor() {
    if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    this.load();
  }

  load() {
    this.state = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : { 
      rodada: '2026-06-24', aberto: false, configuracoes: { totalVagas: 25 }, mensalistas: [], avulsos: [] 
    };
  }

  save() { fs.writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2)); }
  getState() { return this.state; }

  novaSemana() {
    this.state.mensalistas.forEach(m => m.status = 'pendente');
    this.state.avulsos = [];
    this.state.aberto = false;
    this.save();
  }

  updatePlayerStatus(telefone, status) {
    const p = this.state.mensalistas.find(m => onlyDigits(m.telefone) === onlyDigits(telefone));
    if (p) { p.status = status; this.save(); return true; }
    return false;
  }
  
  addMensalista(telefone, nome) {
    this.state.mensalistas.push({ telefone: onlyDigits(telefone), nome, status: 'pendente' });
    this.save();
  }
}

module.exports = { Database, onlyDigits };