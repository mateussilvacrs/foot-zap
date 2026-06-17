// Substitua o início do seu src/database.js por isto:
const fs = require('fs');
const path = require('path');

// Garante que o banco seja salvo no diretório raiz do projeto (/app/data)
const DATA_DIR = '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'estado.json');

class Database {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.load();
  }


  load() {
    if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      this.state = { rodada: '2026-06-24', aberto: false, poll: { active: false }, mensalistas: [], avulsos: [] };
      this.save();
    } else {
      this.state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  }

  save() { fs.writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2)); }

  getState() { return this.state; }

  // A MÁGICA: Reseta apenas o status, mantendo os mensalistas cadastrados
  novaSemana() {
    this.state.mensalistas.forEach(m => m.status = 'pendente');
    this.state.avulsos = [];
    this.state.aberto = false;
    this.save();
  }

  updatePlayerStatus(telefone, status) {
    const p = this.state.mensalistas.find(m => onlyDigits(m.telefone) === onlyDigits(telefone));
    if (p) {
      p.status = status;
      this.save();
      return true;
    }
    return false;
  }
  
  addMensalista(telefone, nome) {
    this.state.mensalistas.push({ telefone: onlyDigits(telefone), nome, status: 'pendente' });
    this.save();
  }
}
module.exports = { Database, onlyDigits };