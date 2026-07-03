// index.js — Auto Habar Bot
// Guruhlarga belgilangan interval bilan avtomatik xabar yuboradi.

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { load, save } = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi. .env faylida BOT_TOKEN ni kiriting.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let db = load();

// Agar .env da admin ID lar berilgan bo'lsa, birinchi ishga tushirishda saqlab qo'yamiz
const envAdmins = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
envAdmins.forEach((id) => {
  if (!db.admins.includes(id)) db.admins.push(id);
});
save(db);

function isAdmin(ctx) {
  return db.admins.includes(ctx.from.id);
}

// ---------- Asosiy menyu (reply keyboard) ----------
const mainMenu = Markup.keyboard([
  ['🚀 Autohabar yuborish', '📝 Habar matni'],
  ['⏱ Interval', '💬 Guruhlarni sozlash'],
  ['👤 Kabinet', '⚙️ Sozlamalar'],
  ['📊 Statistika', '🆘 Yordam'],
]).resize();

// ---------- Holatlarni saqlash uchun oddiy "kutish" mexanizmi ----------
// userId -> 'awaiting_text' | 'awaiting_interval'
const waitingFor = {};

// ---------- /start ----------
bot.start((ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ Kechirasiz, bu bot faqat administratorlar uchun.');
  }
  ctx.reply(
    `👋 Salom, ${ctx.from.first_name}!\n\n` +
    `Bu — Auto Habar boshqaruv paneli.\n` +
    `Quyidagi tugmalar orqali botni sozlashingiz mumkin.`,
    mainMenu
  );
});

// ---------- Bot guruhga qo'shilganda avtomatik saqlash ----------
bot.on('my_chat_member', (ctx) => {
  const update = ctx.myChatMember;
  const chat = update.chat;
  const newStatus = update.new_chat_member.status;

  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (['member', 'administrator'].includes(newStatus)) {
      db.groups[chat.id] = { title: chat.title, addedAt: Date.now() };
      save(db);
      console.log(`✅ Guruh qo'shildi: ${chat.title} (${chat.id})`);
    } else if (['left', 'kicked'].includes(newStatus)) {
      delete db.groups[chat.id];
      save(db);
      console.log(`❌ Guruhdan chiqarildi: ${chat.title} (${chat.id})`);
    }
  }
});

// ---------- 📝 Habar matni ----------
bot.hears('📝 Habar matni', (ctx) => {
  if (!isAdmin(ctx)) return;
  waitingFor[ctx.from.id] = 'awaiting_text';
  ctx.reply(
    `✏️ Yangi xabar matnini yuboring.\n\n` +
    `Hozirgi matn:\n"${db.broadcastText}"`
  );
});

// ---------- ⏱ Interval ----------
bot.hears('⏱ Interval', (ctx) => {
  if (!isAdmin(ctx)) return;
  waitingFor[ctx.from.id] = 'awaiting_interval';
  ctx.reply(
    `⏱ Yangi intervalni soniyalarda kiriting (masalan: 120).\n` +
    `Hozirgi interval: ${db.intervalSeconds} soniya\n` +
    `⚠️ Eng kam qiymat: 30 soniya (spam bo'lib qolmasligi uchun).`
  );
});

// ---------- 💬 Guruhlarni sozlash ----------
bot.hears('💬 Guruhlarni sozlash', (ctx) => {
  if (!isAdmin(ctx)) return;
  const groupIds = Object.keys(db.groups);
  if (groupIds.length === 0) {
    return ctx.reply(
      `📭 Hozircha hech qanday guruh ulanmagan.\n\n` +
      `Botni istalgan guruhga admin qilib qo'shing — u avtomatik ro'yxatga qo'shiladi.`
    );
  }
  const list = groupIds
    .map((id, i) => `${i + 1}. ${db.groups[id].title} (${id})`)
    .join('\n');
  ctx.reply(`📋 Ulangan guruhlar (${groupIds.length} ta):\n\n${list}`);
});

// ---------- 🚀 Autohabar yuborish (on/off) ----------
bot.hears('🚀 Autohabar yuborish', (ctx) => {
  if (!isAdmin(ctx)) return;
  db.autoHabarOn = !db.autoHabarOn;
  save(db);
  ctx.reply(
    db.autoHabarOn
      ? `✅ Autohabar YOQILDI.\nHar ${db.intervalSeconds} soniyada ${Object.keys(db.groups).length} ta guruhga xabar yuboriladi.`
      : `⛔ Autohabar O'CHIRILDI.`
  );
});

// ---------- 👤 Kabinet ----------
bot.hears('👤 Kabinet', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    `👤 Kabinet\n\n` +
    `🆔 ID: ${ctx.from.id}\n` +
    `👤 Ism: ${ctx.from.first_name}\n` +
    `🔘 Auto Habar: ${db.autoHabarOn ? "✅ Yoqilgan" : "❌ O'chiq"}\n` +
    `💬 Guruhlar soni: ${Object.keys(db.groups).length}\n` +
    `⏱ Interval: ${db.intervalSeconds} soniya`
  );
});

// ---------- ⚙️ Sozlamalar ----------
bot.hears('⚙️ Sozlamalar', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    `⚙️ Sozlamalar\n\n` +
    `📝 Matn: "${db.broadcastText.slice(0, 50)}${db.broadcastText.length > 50 ? '...' : ''}"\n` +
    `⏱ Interval: ${db.intervalSeconds} soniya\n` +
    `🔘 Holat: ${db.autoHabarOn ? "✅ Yoqilgan" : "❌ O'chiq"}\n` +
    `💬 Guruhlar: ${Object.keys(db.groups).length} ta`
  );
});

// ---------- 📊 Statistika ----------
bot.hears('📊 Statistika', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    `📊 Statistika\n\n` +
    `💬 Ulangan guruhlar: ${Object.keys(db.groups).length}\n` +
    `🔘 Auto Habar holati: ${db.autoHabarOn ? "✅ Faol" : "❌ Nofaol"}\n` +
    `⏱ Interval: ${db.intervalSeconds} soniya`
  );
});

// ---------- 🆘 Yordam ----------
bot.hears('🆘 Yordam', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.reply(
    `🆘 Yordam\n\n` +
    `1️⃣ Botni guruhingizga admin qilib qo'shing.\n` +
    `2️⃣ "📝 Habar matni" orqali yubormoqchi bo'lgan matnni kiriting.\n` +
    `3️⃣ "⏱ Interval" orqali necha soniyada bir yuborilishini belgilang.\n` +
    `4️⃣ "🚀 Autohabar yuborish" tugmasi bilan yoqing.\n\n` +
    `⚠️ Eslatma: ko'p guruhlarga tez-tez avtomatik xabar yuborish Telegram qoidalariga zid bo'lishi va akkountingiz cheklanishiga olib kelishi mumkin. Guruh a'zolarining roziligisiz spam yubormang.`
  );
});

// ---------- Matnli xabarlarni umumiy ushlab olish (kutilayotgan input) ----------
bot.on('text', (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat.type !== 'private') return;

  const state = waitingFor[ctx.from.id];
  if (!state) return; // Menyu tugmalari yuqorida hears() bilan alohida ushlanadi

  if (state === 'awaiting_text') {
    db.broadcastText = ctx.message.text;
    save(db);
    delete waitingFor[ctx.from.id];
    return ctx.reply('✅ Yangi xabar matni saqlandi.', mainMenu);
  }

  if (state === 'awaiting_interval') {
    const seconds = parseInt(ctx.message.text, 10);
    if (isNaN(seconds) || seconds < 30) {
      return ctx.reply('❌ Noto\'g\'ri qiymat. Kamida 30 soniya kiriting.');
    }
    db.intervalSeconds = seconds;
    save(db);
    delete waitingFor[ctx.from.id];
    restartBroadcastLoop();
    return ctx.reply(`✅ Interval ${seconds} soniyaga o'rnatildi.`, mainMenu);
  }
});

// ---------- Avtomatik yuborish tsikli ----------
let broadcastTimer = null;

async function broadcastToGroups() {
  if (!db.autoHabarOn) return;
  const groupIds = Object.keys(db.groups);
  for (const chatId of groupIds) {
    try {
      await bot.telegram.sendMessage(chatId, db.broadcastText);
    } catch (err) {
      console.error(`Xabar yuborilmadi (${chatId}):`, err.message);
      // Agar bot guruhdan chiqarilgan/bloklangan bo'lsa, ro'yxatdan o'chiramiz
      if (err.response && [403, 400].includes(err.response.error_code)) {
        delete db.groups[chatId];
        save(db);
      }
    }
    // Guruhlar orasida kichik pauza — flood-control ga tushmaslik uchun
    await new Promise((r) => setTimeout(r, 300));
  }
}

function restartBroadcastLoop() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  broadcastTimer = setInterval(broadcastToGroups, db.intervalSeconds * 1000);
}

// ---------- Botni ishga tushirish ----------
bot.launch().then(() => {
  console.log('🤖 Auto Habar Bot ishga tushdi.');
  restartBroadcastLoop();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
