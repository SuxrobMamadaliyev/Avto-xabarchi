// ========== YORDAMCHI FUNKSIYALAR ==========

function parseIdDays(rawText) {
  if (!rawText) return [null, null];
  let s = rawText.trim().replace(/^\//, "");
  if (s.toLowerCase().startsWith("add ")) s = s.slice(4).trim();
  const parts = s.split(/\s+/);
  if (parts.length < 2) return [null, null];
  const userId = parseInt(parts[0]);
  const days = parseInt(parts[1]);
  if (isNaN(userId) || isNaN(days)) return [null, null];
  return [userId, days];
}

// Telegram foydalanuvchi ID (raqam) uchun — /remove buyrug'ida ishlatiladi
function parseSingleId(rawText) {
  if (!rawText) return null;
  let s = rawText.trim().replace(/^\//, "");
  if (s.toLowerCase().startsWith("remove ")) s = s.slice(7).trim();
  const parts = s.split(/\s+/);
  if (!parts.length) return null;
  const id = parseInt(parts[0]);
  return isNaN(id) ? null : id;
}

// MongoDB ObjectId (satr) uchun — /reject buyrug'ida ishlatiladi
function parseRequestId(rawText) {
  if (!rawText) return null;
  let s = rawText.trim().replace(/^\//, "");
  if (s.toLowerCase().startsWith("reject ")) s = s.slice(7).trim();
  const parts = s.split(/\s+/);
  if (!parts.length || !parts[0]) return null;
  return parts[0];
}

function simpleName(displayName) {
  if (!displayName) return displayName;
  return displayName.includes("_") ? displayName.split("_").pop() : displayName;
}

function isSubscriptionActive(subscriptionEnd) {
  if (!subscriptionEnd) return false;
  return new Date(subscriptionEnd) > new Date();
}

function daysLeft(subscriptionEnd) {
  if (!subscriptionEnd) return 0;
  const diff = new Date(subscriptionEnd) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  parseIdDays, parseSingleId, parseRequestId, simpleName,
  isSubscriptionActive, daysLeft, randomInt,
};
