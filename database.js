const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = process.env.SESSIONS_DIR || "sessions";
const ADMIN_ID = Number(process.env.ADMIN_ID);

// ========== YORDAMCHI ==========
function fmtDate(d = new Date()) {
  return d.toISOString().replace("T", " ").substring(0, 19);
}

// Mongoose lean() hujjatini oddiy obyektga aylantirish (_id -> id string)
function mapId(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  return { id: _id ? _id.toString() : undefined, ...rest };
}

// ========== SXEMALAR ==========
const accountSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  display_name: { type: String, unique: true },
  phone: { type: String, default: "" },
  country_code: { type: String, default: "" },
  username: { type: String, default: "" },
  is_active: { type: Number, default: 0 },
  is_premium: { type: Number, default: 0 },
  is_default: { type: Number, default: 0 },
  subscription_end: { type: String, default: null },
  created_at: { type: String, default: () => fmtDate() },
});

const groupSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  account_display_name: { type: String, required: true },
  group_id: { type: String },
  group_title: { type: String },
  group_username: { type: String, default: "" },
  is_active: { type: Number, default: 1 },
  added_at: { type: String, default: () => fmtDate() },
});
groupSchema.index({ user_id: 1, account_display_name: 1, group_id: 1 }, { unique: true });

const messageSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  message_type: { type: String, default: "text" },
  storage_data: { type: String, default: null },
  text: { type: String, default: "" },
  created_at: { type: String, default: () => fmtDate() },
});

const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: String },
  updated_at: { type: String, default: () => fmtDate() },
});

const requestSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  username: { type: String, default: "" },
  first_name: { type: String, default: "" },
  last_name: { type: String, default: "" },
  status: { type: String, default: "pending" },
  admin_note: { type: String, default: "" },
  created_at: { type: String, default: () => fmtDate() },
});

const userIntervalSchema = new mongoose.Schema({
  user_id: { type: Number, unique: true },
  min_interval: { type: Number, default: 20 },
  max_interval: { type: Number, default: 25 },
  created_at: { type: String, default: () => fmtDate() },
});

const pendingSessionSchema = new mongoose.Schema({
  display_name: { type: String, unique: true },
  phone: { type: String },
  code_hash: { type: String },
  user_id: { type: Number },
  created_at: { type: String, default: () => fmtDate() },
});

const sessionLogSchema = new mongoose.Schema({
  display_name: { type: String },
  action: { type: String },
  status: { type: String },
  message: { type: String },
  created_at: { type: String, default: () => fmtDate() },
});

const Account = mongoose.model("Account", accountSchema, "accounts");
const Group = mongoose.model("Group", groupSchema, "groups");
const Message = mongoose.model("Message", messageSchema, "messages");
const Setting = mongoose.model("Setting", settingSchema, "settings");
const Request = mongoose.model("Request", requestSchema, "requests");
const UserInterval = mongoose.model("UserInterval", userIntervalSchema, "user_intervals");
const PendingSession = mongoose.model("PendingSession", pendingSessionSchema, "pending_sessions");
const SessionLog = mongoose.model("SessionLog", sessionLogSchema, "session_logs");

// ========== ULANISH ==========
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI .env faylida topilmadi!");

  mongoose.connection.on("connected", () => console.log("✅ MongoDB ga ulandi"));
  mongoose.connection.on("error", (e) => console.error("❌ MongoDB xatosi:", e.message));

  await mongoose.connect(uri);

  // Default sozlamalar (faqat mavjud bo'lmasa yaratiladi)
  const defaultSettings = [
    ["min_interval", process.env.MIN_INTERVAL || "20"],
    ["max_interval", process.env.MAX_INTERVAL || "25"],
    ["random_messages", process.env.RANDOM_MESSAGES || "true"],
    ["welcome_message", "Botdan foydalanish uchun ruxsat kerak. Ruxsat olish uchun @Okean_manager ga murojaat qiling."],
    ["admin_contact", "@Okean_manager"],
    ["api_id", String(process.env.API_ID || "")],
    ["api_hash", process.env.API_HASH || ""],
    ["storage_channel", process.env.STORAGE_CHANNEL_USERNAME || "not_set"],
  ];

  for (const [key, value] of defaultSettings) {
    await Setting.updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }

  console.log("✅ Baza tayyor");
}

// ========== SETTINGS ==========
async function saveSetting(key, value) {
  await Setting.updateOne(
    { key },
    { $set: { value, updated_at: fmtDate() } },
    { upsert: true }
  );
}

async function getSetting(key, defaultValue = null) {
  const row = await Setting.findOne({ key }).lean();
  return row ? row.value : defaultValue;
}

async function getStorageChannel() {
  const ch = await getSetting("storage_channel", process.env.STORAGE_CHANNEL_USERNAME || "not_set");
  return ch && ch !== "not_set" ? ch : (process.env.STORAGE_CHANNEL_USERNAME || "not_set");
}

// ========== ACCOUNTS ==========
async function getNextAccountNumber(userId) {
  const rows = await Account.find({
    user_id: userId,
    display_name: { $regex: `^account_${userId}_` },
  }).lean();

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

async function getUserAccountsCount(userId) {
  return Account.countDocuments({
    user_id: userId,
    $or: [{ is_default: 0 }, { is_default: null }, { is_default: { $exists: false } }],
  });
}

async function addUserAccount(userId, phone = "", countryCode = "", username = "", displayName = null) {
  const count = await getUserAccountsCount(userId);
  if (count >= 5) return null;

  if (!displayName) {
    const num = await getNextAccountNumber(userId);
    if (!num) return null;
    displayName = `account_${userId}_${num}`;
  }

  if (phone) {
    const exists = await Account.findOne({ phone }).lean();
    if (exists) return null;
  }

  const nameExists = await Account.findOne({ display_name: displayName }).lean();
  if (nameExists) {
    const num = await getNextAccountNumber(userId);
    if (!num) return null;
    displayName = `account_${userId}_${num}`;
  }

  try {
    await Account.create({
      user_id: userId,
      display_name: displayName,
      phone,
      country_code: countryCode,
      username,
      is_active: 0,
      is_premium: 0,
    });
    return displayName;
  } catch (e) {
    console.error("addUserAccount xato:", e.message);
    return null;
  }
}

async function getUserAccounts(userId) {
  const rows = await Account.find({
    user_id: userId,
    $or: [{ is_default: 0 }, { is_default: null }, { is_default: { $exists: false } }],
  })
    .sort({ display_name: 1 })
    .lean();
  return rows.map(mapId);
}

async function getAllUsers() {
  const ids = await Account.distinct("user_id", { user_id: { $ne: ADMIN_ID } });
  return ids;
}

async function getAllActiveUserIds() {
  const now = fmtDate();
  const ids = await Account.distinct("user_id", {
    user_id: { $ne: ADMIN_ID },
    subscription_end: { $gt: now },
    is_active: 1,
  });
  return ids;
}

async function getUserSubscription(userId) {
  const row = await Account.findOne({ user_id: userId, is_active: 1 })
    .sort({ subscription_end: -1 })
    .lean();
  if (!row) return { subscriptionEnd: null, isPremium: false };
  return { subscriptionEnd: row.subscription_end, isPremium: !!row.is_premium };
}

async function updateUserSubscription(userId, days) {
  let subscriptionEnd = null;
  let isPremium = 0;

  if (days > 0) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    subscriptionEnd = fmtDate(d);
    isPremium = 1;
  }

  const exists = await Account.findOne({ user_id: userId }).lean();
  if (!exists) {
    const displayName = `default_${userId}`;
    await Account.create({
      user_id: userId,
      display_name: displayName,
      phone: "",
      country_code: "",
      username: "",
      is_active: 1,
      is_premium: isPremium,
      is_default: 1,
      subscription_end: subscriptionEnd,
    });
  }

  await Account.updateMany(
    { user_id: userId },
    { $set: { subscription_end: subscriptionEnd, is_premium: isPremium, is_active: 1 } }
  );

  if (days > 0) {
    await Group.updateMany({ user_id: userId }, { $set: { is_active: 1 } });
  }

  return subscriptionEnd;
}

async function deleteUserAccount(userId, displayName) {
  const acc = await Account.findOne({ user_id: userId, display_name: displayName }).lean();
  if (!acc) return false;

  await Account.deleteOne({ user_id: userId, display_name: displayName });
  await Group.deleteMany({ user_id: userId, account_display_name: displayName });
  await PendingSession.deleteOne({ display_name: displayName });

  const sessionPath = getSessionPath(displayName);
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  if (fs.existsSync(sessionPath + "-journal")) fs.unlinkSync(sessionPath + "-journal");

  return true;
}

async function deleteUserData(userId) {
  await Account.deleteMany({ user_id: userId });
  await Group.deleteMany({ user_id: userId });
  await Message.deleteMany({ user_id: userId });
  await Request.deleteMany({ user_id: userId });
  await UserInterval.deleteMany({ user_id: userId });
  return true;
}

async function setAccountActive(displayName) {
  await Account.updateOne({ display_name: displayName }, { $set: { is_active: 1 } });
}

// ========== GROUPS ==========
async function addGroupBatch(userId, accountDisplayName, groupsList) {
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
      await Group.create({
        user_id: userId,
        account_display_name: accountDisplayName,
        group_id: groupId,
        group_title: groupTitle,
        group_username: groupUsername,
        is_active: 1,
      });
      added++;
    } catch (e) {
      skipped++;
    }
  }

  return { added, skipped };
}

async function getUserGroups(userId, accountDisplayName) {
  const rows = await Group.find({ user_id: userId, account_display_name: accountDisplayName })
    .sort({ group_title: 1 })
    .lean();
  return rows.map(mapId);
}

async function getUserGroupsCount(userId) {
  return Group.countDocuments({ user_id: userId });
}

async function updateGroupActiveStatus(groupIds, isActive) {
  const result = await Group.updateMany(
    { _id: { $in: groupIds.filter((id) => mongoose.isValidObjectId(id)) } },
    { $set: { is_active: isActive } }
  );
  return result.modifiedCount || 0;
}

async function getGroupById(groupId) {
  if (!mongoose.isValidObjectId(groupId)) return null;
  const row = await Group.findById(groupId).lean();
  return mapId(row);
}

async function deleteGroupById(groupId) {
  if (!mongoose.isValidObjectId(groupId)) return false;
  const result = await Group.deleteOne({ _id: groupId });
  return result.deletedCount > 0;
}

// ========== MESSAGES ==========
async function addUserMessage(userId, text, messageType = "text", storageData = null) {
  await Message.create({ user_id: userId, message_type: messageType, storage_data: storageData, text });
}

async function getUserMessages(userId) {
  const rows = await Message.find({ user_id: userId }).sort({ _id: 1 }).lean();
  return rows.map(mapId);
}

async function getRandomUserMessage(userId) {
  const msgs = await getUserMessages(userId);
  if (!msgs.length) return null;
  const m = msgs[Math.floor(Math.random() * msgs.length)];
  return { id: m.id, message_type: m.message_type || "text", storage_data: m.storage_data, text: m.text };
}

async function deleteUserMessages(userId) {
  const result = await Message.deleteMany({ user_id: userId });
  return result.deletedCount || 0;
}

async function deleteSingleMessage(messageId) {
  if (!mongoose.isValidObjectId(messageId)) return false;
  const result = await Message.deleteOne({ _id: messageId });
  return result.deletedCount > 0;
}

// ========== REQUESTS ==========
async function addRequest(userId, username, firstName, lastName) {
  const existing = await Request.findOne({ user_id: userId, status: "pending" }).lean();
  if (existing) return existing._id.toString();

  try {
    const created = await Request.create({
      user_id: userId,
      username: username || "",
      first_name: firstName,
      last_name: lastName,
      status: "pending",
    });
    return created._id.toString();
  } catch (e) {
    console.error("addRequest xato:", e.message);
    return false;
  }
}

async function getPendingRequests() {
  const rows = await Request.find({ status: "pending" }).sort({ created_at: 1 }).lean();
  return rows.map(mapId);
}

async function getRequestById(requestId) {
  if (!mongoose.isValidObjectId(requestId)) return null;
  const row = await Request.findById(requestId).lean();
  return mapId(row);
}

async function getRequestByUserId(userId) {
  const row = await Request.findOne({ user_id: userId, status: "pending" }).sort({ _id: -1 }).lean();
  return mapId(row);
}

async function updateRequestStatus(requestId, status, adminNote = "") {
  if (!mongoose.isValidObjectId(requestId)) return false;
  await Request.updateOne({ _id: requestId }, { $set: { status, admin_note: adminNote } });
  return true;
}

// ========== USER INTERVALS ==========
async function saveUserInterval(userId, minInterval, maxInterval) {
  await UserInterval.updateOne(
    { user_id: userId },
    { $set: { min_interval: minInterval, max_interval: maxInterval } },
    { upsert: true }
  );
}

async function getUserInterval(userId) {
  const row = await UserInterval.findOne({ user_id: userId }).lean();
  if (row) return { min: row.min_interval, max: row.max_interval };
  const globalMin = parseInt(await getSetting("min_interval", "20"));
  const globalMax = parseInt(await getSetting("max_interval", "25"));
  return { min: globalMin, max: globalMax };
}

// ========== PENDING SESSIONS ==========
async function getPendingSession(displayName) {
  return PendingSession.findOne({ display_name: displayName }).lean();
}

async function removePendingSession(displayName) {
  await PendingSession.deleteOne({ display_name: displayName });
}

async function getPendingSessionByUser(userId) {
  return PendingSession.findOne({ user_id: userId }).sort({ created_at: -1 }).lean();
}

async function savePendingSession(displayName, phone, codeHash, userId) {
  await PendingSession.updateOne(
    { display_name: displayName },
    { $set: { phone, code_hash: codeHash, user_id: userId, created_at: fmtDate() } },
    { upsert: true }
  );
}

async function getAllPendingSessions() {
  return PendingSession.find({}).lean();
}

// ========== SESSION LOGS ==========
async function logSessionAction(displayName, action, status, message) {
  await SessionLog.create({ display_name: displayName, action, status, message });
}

// ========== SESSION PATH ==========
function getSessionPath(displayName) {
  const safeName = displayName.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(SESSIONS_DIR, `${safeName}.session`);
}

function sessionExists(displayName) {
  return fs.existsSync(getSessionPath(displayName));
}

async function getUserByDisplayName(displayName) {
  const row = await Account.findOne({ display_name: displayName }).lean();
  return row ? row.user_id : null;
}

module.exports = {
  connectDB,
  getSetting, saveSetting, getStorageChannel,
  addUserAccount, getUserAccounts, getUserAccountsCount, getNextAccountNumber,
  getAllUsers, getAllActiveUserIds, getUserSubscription, updateUserSubscription,
  deleteUserAccount, deleteUserData, getUserByDisplayName, setAccountActive,
  addGroupBatch, getUserGroups, getUserGroupsCount, updateGroupActiveStatus, getGroupById, deleteGroupById,
  addUserMessage, getUserMessages, getRandomUserMessage, deleteUserMessages, deleteSingleMessage,
  addRequest, getPendingRequests, getRequestById, getRequestByUserId, updateRequestStatus,
  saveUserInterval, getUserInterval,
  getPendingSession, removePendingSession, getPendingSessionByUser, savePendingSession, getAllPendingSessions,
  logSessionAction, getSessionPath, sessionExists,
};
