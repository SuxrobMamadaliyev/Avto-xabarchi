const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const config = require("./config");

let db;

function getDb() {
  if (!db) {
    db = new Database(config.DB_FILE);
    db.pragma("journal_mode = WAL");
  }
  return db;
}

function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      display_name TEXT UNIQUE,
      phone TEXT,
      country_code TEXT,
      username TEXT,
      is_active INTEGER DEFAULT 0,
      is_premium INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      subscription_end DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      account_display_name TEXT,
      group_id TEXT,
      group_title TEXT,
      group_username TEXT,
      is_active INTEGER DEFAULT 1,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, account_display_name, group_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      message_type TEXT DEFAULT 'text',
      storage_data TEXT,
      text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      status TEXT DEFAULT 'pending',
      admin_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_intervals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      min_interval INTEGER DEFAULT 20,
      max_interval INTEGER DEFAULT 25,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT UNIQUE,
      phone TEXT,
      code_hash TEXT,
      user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS session_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT,
      action TEXT,
      status TEXT,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_user_id ON accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_user_intervals_user_id ON user_intervals(user_id);
    CREATE INDEX IF NOT EXISTS idx_pending_sessions_display_name ON pending_sessions(display_name);
  `);

  // Default sozlamalar
  const defaultSettings = [
    ["min_interval", "20"],
    ["max_interval", "25"],
    ["random_messages", "true"],
    ["welcome_message", "Botdan foydalanish uchun ruxsat kerak. Ruxsat olish uchun @Okean_manager ga murojaat qiling."],
    ["admin_contact", "@Okean_manager"],
    ["api_id", String(config.API_ID)],
    ["api_hash", config.API_HASH],
    ["storage_channel", config.STORAGE_CHANNEL_USERNAME],
  ];

  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }

  console.log("✅ Baza yaratildi/tekshirildi");
}

// ========== SETTINGS ==========
function saveSetting(key, value) {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function getSetting(key, defaultValue = null) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

function getStorageChannel() {
  const ch = getSetting("storage_channel", config.STORAGE_CHANNEL_USERNAME);
  return ch && ch !== "not_set" ? ch : config.STORAGE_CHANNEL_USERNAME;
}

// ========== ACCOUNTS ==========
function getNextAccountNumber(userId) {
  const rows = getDb()
    .prepare(`SELECT display_name FROM accounts WHERE user_id = ? AND display_name LIKE ?`)
    .all(userId, `account_${userId}_%`);

  if (!rows.length) return 1;

  const numbers = rows
    .map((r) => {
      const parts = r.display_name.split("_");
      const n = parseInt(parts[parts.length - 1]);
      return isNaN(n) ? null : n;
    })
    .filter((n) => n !== null);

  if (numbers.length >= 5) return null;
  for (let i = 1; i <= 5; i++) {
    if (!numbers.includes(i)) return i;
  }
  return Math.max(...numbers) + 1;
}

function getUserAccountsCount(userId) {
  const row = getDb()
    .prepare("SELECT COUNT(*) as cnt FROM accounts WHERE user_id = ? AND (is_default = 0 OR is_default IS NULL)")
    .get(userId);
  return row.cnt;
}

function addUserAccount(userId, phone = "", countryCode = "", username = "", displayName = null) {
  const count = getUserAccountsCount(userId);
  if (count >= 5) return null;

  const db = getDb();

  if (!displayName) {
    const num = getNextAccountNumber(userId);
    if (!num) return null;
    displayName = `account_${userId}_${num}`;
  }

  if (phone) {
    const exists = db.prepare("SELECT display_name FROM accounts WHERE phone = ?").get(phone);
    if (exists) return null;
  }

  const nameExists = db.prepare("SELECT user_id FROM accounts WHERE display_name = ?").get(displayName);
  if (nameExists) {
    const num = getNextAccountNumber(userId);
    if (!num) return null;
    displayName = `account_${userId}_${num}`;
  }

  try {
    db.prepare(
      "INSERT INTO accounts (user_id, display_name, phone, country_code, username, is_active, is_premium) VALUES (?, ?, ?, ?, ?, 0, 0)"
    ).run(userId, displayName, phone, countryCode, username);
    return displayName;
  } catch (e) {
    console.error("addUserAccount xato:", e.message);
    return null;
  }
}

function getUserAccounts(userId) {
  return getDb()
    .prepare(
      `SELECT display_name, phone, country_code, username, is_active, is_premium, subscription_end
       FROM accounts WHERE user_id = ? AND (is_default = 0 OR is_default IS NULL) ORDER BY display_name`
    )
    .all(userId);
}

function getAllUsers() {
  return getDb()
    .prepare("SELECT DISTINCT user_id FROM accounts WHERE user_id != ?")
    .all(config.ADMIN_ID)
    .map((r) => r.user_id);
}

function getAllActiveUserIds() {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  return getDb()
    .prepare(
      "SELECT DISTINCT user_id FROM accounts WHERE user_id != ? AND subscription_end > ? AND is_active = 1"
    )
    .all(config.ADMIN_ID, now)
    .map((r) => r.user_id);
}

function getUserSubscription(userId) {
  const row = getDb()
    .prepare(
      "SELECT subscription_end, is_premium FROM accounts WHERE user_id = ? AND is_active = 1 ORDER BY subscription_end DESC LIMIT 1"
    )
    .get(userId);
  if (!row) return { subscriptionEnd: null, isPremium: false };
  return { subscriptionEnd: row.subscription_end, isPremium: !!row.is_premium };
}

function updateUserSubscription(userId, days) {
  const db = getDb();
  let subscriptionEnd = null;
  let isPremium = 0;

  if (days > 0) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    subscriptionEnd = d.toISOString().replace("T", " ").substring(0, 19);
    isPremium = 1;
  }

  const exists = db.prepare("SELECT id FROM accounts WHERE user_id = ?").get(userId);
  if (!exists) {
    const displayName = `default_${userId}`;
    db.prepare(
      "INSERT INTO accounts (user_id, display_name, phone, country_code, username, is_active, is_premium, is_default, subscription_end) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)"
    ).run(userId, displayName, "", "", "", isPremium, subscriptionEnd);
  }

  db.prepare(
    "UPDATE accounts SET subscription_end = ?, is_premium = ?, is_active = 1 WHERE user_id = ?"
  ).run(subscriptionEnd, isPremium, userId);

  if (days > 0) {
    db.prepare("UPDATE groups SET is_active = 1 WHERE user_id = ?").run(userId);
  }

  return subscriptionEnd;
}

function deleteUserAccount(userId, displayName) {
  const db = getDb();
  const acc = db.prepare("SELECT id FROM accounts WHERE user_id = ? AND display_name = ?").get(userId, displayName);
  if (!acc) return false;

  db.prepare("DELETE FROM accounts WHERE user_id = ? AND display_name = ?").run(userId, displayName);
  db.prepare("DELETE FROM groups WHERE user_id = ? AND account_display_name = ?").run(userId, displayName);
  db.prepare("DELETE FROM pending_sessions WHERE display_name = ?").run(displayName);

  // Session faylini o'chirish
  const sessionPath = getSessionPath(displayName);
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  if (fs.existsSync(sessionPath + "-journal")) fs.unlinkSync(sessionPath + "-journal");

  return true;
}

function deleteUserData(userId) {
  const db = getDb();
  db.prepare("DELETE FROM accounts WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM groups WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM requests WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_intervals WHERE user_id = ?").run(userId);
  return true;
}

// ========== GROUPS ==========
function addGroupBatch(userId, accountDisplayName, groupsList) {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO groups (user_id, account_display_name, group_id, group_title, group_username, is_active) VALUES (?, ?, ?, ?, ?, 1)"
  );

  let added = 0, skipped = 0;

  for (let raw of groupsList) {
    raw = raw.trim();
    if (!raw) continue;

    let groupId, groupUsername = "";
    const groupTitle = raw;

    if (raw.startsWith("@")) {
      groupId = raw;
      groupUsername = raw.slice(1);
    } else if (raw.startsWith("https://t.me/")) {
      const uname = raw.split("/").pop();
      groupId = uname.startsWith("+") ? uname : `@${uname}`;
      groupUsername = uname.startsWith("+") ? "" : uname;
    } else if (raw.startsWith("-100")) {
      groupId = raw;
    } else if (raw.startsWith("+")) {
      groupId = raw;
    } else {
      groupId = `@${raw}`;
      groupUsername = raw;
    }

    try {
      const result = insert.run(userId, accountDisplayName, groupId, groupTitle, groupUsername);
      result.changes > 0 ? added++ : skipped++;
    } catch {
      skipped++;
    }
  }

  return { added, skipped };
}

function getUserGroups(userId, accountDisplayName) {
  return getDb()
    .prepare(
      "SELECT id, group_id, group_title, group_username, is_active FROM groups WHERE user_id = ? AND account_display_name = ? ORDER BY group_title"
    )
    .all(userId, accountDisplayName);
}

function updateGroupActiveStatus(groupIds, isActive) {
  const stmt = getDb().prepare("UPDATE groups SET is_active = ? WHERE id = ?");
  let count = 0;
  for (const id of groupIds) {
    count += stmt.run(isActive, id).changes;
  }
  return count;
}

function getGroupById(groupId) {
  return getDb()
    .prepare("SELECT id, user_id, account_display_name, group_id, group_title, group_username, is_active FROM groups WHERE id = ?")
    .get(groupId);
}

function deleteGroupById(groupId) {
  return getDb().prepare("DELETE FROM groups WHERE id = ?").run(groupId).changes > 0;
}

// ========== MESSAGES ==========
function addUserMessage(userId, text, messageType = "text", storageData = null) {
  getDb()
    .prepare("INSERT INTO messages (user_id, message_type, storage_data, text) VALUES (?, ?, ?, ?)")
    .run(userId, messageType, storageData, text);
}

function getUserMessages(userId) {
  return getDb()
    .prepare("SELECT id, message_type, storage_data, text FROM messages WHERE user_id = ? ORDER BY id")
    .all(userId);
}

function getRandomUserMessage(userId) {
  const msgs = getUserMessages(userId);
  if (!msgs.length) return null;
  const m = msgs[Math.floor(Math.random() * msgs.length)];
  return { id: m.id, message_type: m.message_type || "text", storage_data: m.storage_data, text: m.text };
}

function deleteUserMessages(userId) {
  return getDb().prepare("DELETE FROM messages WHERE user_id = ?").run(userId).changes;
}

function deleteSingleMessage(messageId) {
  return getDb().prepare("DELETE FROM messages WHERE id = ?").run(messageId).changes > 0;
}

// ========== REQUESTS ==========
function addRequest(userId, username, firstName, lastName) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM requests WHERE user_id = ? AND status = 'pending'").get(userId);
  if (existing) return existing.id;

  try {
    const result = db.prepare(
      "INSERT INTO requests (user_id, username, first_name, last_name, status) VALUES (?, ?, ?, ?, 'pending')"
    ).run(userId, username || "", firstName, lastName);
    return result.lastInsertRowid;
  } catch (e) {
    console.error("addRequest xato:", e.message);
    return false;
  }
}

function getPendingRequests() {
  return getDb()
    .prepare("SELECT id, user_id, username, first_name, last_name, created_at FROM requests WHERE status = 'pending' ORDER BY created_at ASC")
    .all();
}

function getRequestById(requestId) {
  return getDb().prepare("SELECT * FROM requests WHERE id = ?").get(requestId);
}

function getRequestByUserId(userId) {
  return getDb()
    .prepare("SELECT * FROM requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
    .get(userId);
}

function updateRequestStatus(requestId, status, adminNote = "") {
  getDb().prepare("UPDATE requests SET status = ?, admin_note = ? WHERE id = ?").run(status, adminNote, requestId);
  return true;
}

// ========== USER INTERVALS ==========
function saveUserInterval(userId, minInterval, maxInterval) {
  getDb()
    .prepare("INSERT OR REPLACE INTO user_intervals (user_id, min_interval, max_interval) VALUES (?, ?, ?)")
    .run(userId, minInterval, maxInterval);
}

function getUserInterval(userId) {
  const row = getDb().prepare("SELECT min_interval, max_interval FROM user_intervals WHERE user_id = ?").get(userId);
  if (row) return { min: row.min_interval, max: row.max_interval };
  const globalMin = parseInt(getSetting("min_interval", "20"));
  const globalMax = parseInt(getSetting("max_interval", "25"));
  return { min: globalMin, max: globalMax };
}

// ========== PENDING SESSIONS ==========
function getPendingSession(displayName) {
  return getDb().prepare("SELECT phone, code_hash, user_id FROM pending_sessions WHERE display_name = ?").get(displayName);
}

function removePendingSession(displayName) {
  getDb().prepare("DELETE FROM pending_sessions WHERE display_name = ?").run(displayName);
}

function getPendingSessionByUser(userId) {
  return getDb()
    .prepare("SELECT display_name, phone, code_hash FROM pending_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(userId);
}

function savePendingSession(displayName, phone, codeHash, userId) {
  getDb()
    .prepare("INSERT OR REPLACE INTO pending_sessions (display_name, phone, code_hash, user_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
    .run(displayName, phone, codeHash, userId);
}

// ========== SESSION LOGS ==========
function logSessionAction(displayName, action, status, message) {
  getDb()
    .prepare("INSERT INTO session_logs (display_name, action, status, message) VALUES (?, ?, ?, ?)")
    .run(displayName, action, status, message);
}

// ========== SESSION PATH ==========
function getSessionPath(displayName) {
  const safeName = displayName.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(config.SESSIONS_DIR, `${safeName}.session`);
}

function sessionExists(displayName) {
  return fs.existsSync(getSessionPath(displayName));
}

function getUserByDisplayName(displayName) {
  const row = getDb().prepare("SELECT user_id FROM accounts WHERE display_name = ?").get(displayName);
  return row ? row.user_id : null;
}

module.exports = {
  initDatabase,
  getSetting, saveSetting, getStorageChannel,
  addUserAccount, getUserAccounts, getUserAccountsCount, getNextAccountNumber,
  getAllUsers, getAllActiveUserIds, getUserSubscription, updateUserSubscription,
  deleteUserAccount, deleteUserData, getUserByDisplayName,
  addGroupBatch, getUserGroups, updateGroupActiveStatus, getGroupById, deleteGroupById,
  addUserMessage, getUserMessages, getRandomUserMessage, deleteUserMessages, deleteSingleMessage,
  addRequest, getPendingRequests, getRequestById, getRequestByUserId, updateRequestStatus,
  saveUserInterval, getUserInterval,
  getPendingSession, removePendingSession, getPendingSessionByUser, savePendingSession,
  logSessionAction, getSessionPath, sessionExists,
};
