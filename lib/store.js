// Tiny JSON-file datastore. One file, loaded at boot, written on every
// mutation via tmp-file + rename so a crash can't corrupt it.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PEAK_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  seq: 0,
  subscriptions: [],
  deliveries: [],
  debitOrders: [],
  transactions: [],
  bankAccounts: [],
};

let db = null;

function load() {
  if (db) return db;
  try {
    db = { ...EMPTY, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    db = JSON.parse(JSON.stringify(EMPTY));
  }
  return db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function nextId(prefix) {
  const d = load();
  d.seq += 1;
  return `${prefix}-${String(d.seq).padStart(5, '0')}`;
}

module.exports = { load, save, nextId, DB_FILE };
