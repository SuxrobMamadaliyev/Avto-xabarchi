// db.js — oddiy fayl asosidagi ma'lumotlar bazasi (DB shart emas)
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const DEFAULT_DATA = {
  groups: {},        // { chatId: { title, addedAt } }
  broadcastText: "Bu — avtomatik xabar matni. Uni 'Habar matni' tugmasi orqali o'zgartiring.",
  intervalSeconds: 120,
  autoHabarOn: false,
  admins: [],
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DATA, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { load, save, DEFAULT_DATA };
