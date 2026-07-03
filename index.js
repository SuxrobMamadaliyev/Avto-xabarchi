// index.js — Auto Habar Bot
// Guruhlarga belgilangan interval bilan avtomatik xabar yuboradi.
// Ma'lumotlar MongoDB da saqlanadi, Render'da webhook rejimida ishlaydi.

require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const db_module = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi. .env faylida BOT_TOKEN ni kiriting.');
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI topilmadi. .env faylida MONGODB_URI ni kiriting.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// `db` handlerlar yozilayotganda hali yuklanmagan bo'ladi (u pastda, main() ichida
// asinxron yuklanadi) — lekin handlerlar faqat xabar kelganda ishga tushgani uchun
// bu muammo emas, chunki shu vaqtga kelib `db` allaqachon to'ldirilgan bo'ladi.
let db;

function save(data) {
  return db_module.save(data);
}

function isAdmin(ctx) {
  return db.admins.includes(ctx.from.id);
}

// ---------- Asosiy menyu (reply keyboard) ----------
const mainMenu = Markup.keyboard([
  ['🚀 Autohabar yuborish', '📝 Habar matni'],
  ['⏱ Interval', '💬 Guruhlarni sozlash'],
  ['📢 Majburiy obuna', '👤 Kabinet'],
  ['⚙️ Sozlamalar', '📊 Statistika'],
  ['🆘 Yordam'],
]).resize();

// ---------- Holatlarni saqlash uchun oddiy "kutish" mexanizmi ----------
// userId -> 'awaiting_text' | 'awaiting_interval' | 'awaiting_channel'
const waitingFor = {};

// ---------- Majburiy obuna: yordamchi funksiyalar ----------
function channelListKeyboard() {
  const rows = db.forceSubChannels.map((ch) => [
    Markup.button.callback(`❌ ${ch.title || ch.username}`, `rmch:${ch.chatId}`),
  ]);
  rows.push([Markup.button.callback("➕ Kanal qo'shish", 'addch')]);
  return Markup.inlineKeyboard(rows);
}

async function checkUserSubscription(ctx) {
  const notJoined = [];
  for (const ch of db.forceSubChannels) {
    try {
      const member = await ctx.telegram.getChatMember(ch.chatId, ctx.from.id);
      if (!['member', 'administrator', 'creator'].includes(member.status)) {
        notJoined.push(ch);
      }
    } catch (err) {
      console.error(`Obuna tekshirilmadi (${ch.chatId}):`, err.message);
    }
  }
  return notJoined;
}

function subscriptionPrompt(notJoined) {
  const buttons = notJoined.map((ch) => [
    Markup.button.url(`📢 ${ch.title || ch.username}`, ch.inviteLink),
  ]);
  buttons.push([Markup.button.callback('✅ Tekshirish', 'check_sub')]);
  return {
    text: "⚠️ Botdan foydalanish uchun quyidagi kanal(lar)ga a'zo bo'ling:",
    keyboard: Markup.inlineKeyboard(buttons),
  };
}

async function sendMainMenu(ctx) {
  if (!isAdmin(ctx)) {
    return ctx.reply("✅ Obuna tasdiqlandi! Rahmat.");
  }
  ctx.reply(
    `👋 Salom, ${ctx.from.first_name}!\n\n` +
    `Bu — Auto Habar boshqaruv paneli.\n` +
    `Quyidagi tugmalar orqali botni sozlashingiz mumkin.`,
    mainMenu
  );
}

// ---------- /start ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return;

  if (db.forceSubChannels.length > 0) {
    const notJoined = await checkUserSubscription(ctx);
    if (notJoined.length > 0) {
      const { text, keyboard } = subscriptionPrompt(notJoined);
      return ctx.reply(text, keyboard);
    }
  }

  if (!isAdmin(ctx)) {
    return ctx.reply("✅ Obuna tasdiqlandi! Rahmat.");
  }

  await sendMainMenu(ctx);
});

// ---------- Obunani "✅ Tekshirish" tugmasi ----------
bot.action('check_sub', async (ctx) => {
  const notJoined = await checkUserSubscription(ctx);
  if (notJoined.length > 0) {
    return ctx.answerCbQuery("❌ Siz hali barcha kanallarga a'zo bo'lmagansiz.", { show_alert: true });
  }
  await ctx.answerCbQuery('✅ Obuna tasdiqlandi!');
  await ctx.deleteMessage().catch(() => {});
  await sendMainMenu(ctx);
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

// ---------- 📢 Majburiy obuna ----------
bot.hears('📢 Majburiy obuna', (ctx) => {
  if (!isAdmin(ctx)) return;
  const count = db.forceSubChannels.length;
  ctx.reply(
    count > 0
      ? `📢 Majburiy obuna kanallari (${count} ta):\n\nKanalni o'chirish uchun tugmani bosing, yoki yangi kanal qo'shing.`
      : `📢 Hozircha majburiy obuna kanali yo'q.\n\nQo'shish uchun tugmani bosing.`,
    channelListKeyboard()
  );
});

// Yangi kanal qo'shishni boshlash
bot.action('addch', async (ctx) => {
  if (!isAdmin(ctx)) return;
  waitingFor[ctx.from.id] = 'awaiting_channel';
  await ctx.answerCbQuery();
  ctx.reply(
    `➕ Kanal qo'shish\n\n` +
    `Botni kanalingizga *administrator* qilib qo'shing, so'ng shu kanaldan istalgan xabarni botga forward qiling ` +
    `(yoki kanal username'ini @kanal shaklida yuboring).`,
    { parse_mode: 'Markdown' }
  );
});

// Kanalni o'chirish
bot.action(/^rmch:(-?\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const chatId = ctx.match[1];
  db.forceSubChannels = db.forceSubChannels.filter((ch) => String(ch.chatId) !== String(chatId));
  save(db);
  await ctx.answerCbQuery('🗑 Kanal o\'chirildi.');
  try {
    await ctx.editMessageReplyMarkup(channelListKeyboard().reply_markup);
  } catch (e) { /* xabar allaqachon yangilangan bo'lishi mumkin */ }
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
    `📢 Majburiy obuna kanallari: ${db.forceSubChannels.length}\n` +
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
    `4️⃣ Xohlasangiz "📢 Majburiy obuna" orqali kanal(lar) qo'shing — bot foydalanuvchilaridan shu kanal(lar)ga a'zo bo'lishni talab qiladi.\n` +
    `5️⃣ "🚀 Autohabar yuborish" tugmasi bilan yoqing.\n\n` +
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

  if (state === 'awaiting_channel') {
    return handleAddChannel(ctx);
  }
});

// ---------- Majburiy obuna kanalini qo'shish (forward yoki @username orqali) ----------
async function handleAddChannel(ctx) {
  let targetChatId = null;

  // 1) Kanaldan forward qilingan xabar
  if (ctx.message.forward_from_chat && ctx.message.forward_from_chat.type === 'channel') {
    targetChatId = ctx.message.forward_from_chat.id;
  }
  // 2) @username yoki -100... ID sifatida yuborilgan
  else if (ctx.message.text) {
    const t = ctx.message.text.trim();
    targetChatId = t.startsWith('@') || t.startsWith('-') ? t : `@${t}`;
  }

  if (!targetChatId) {
    return ctx.reply("❌ Kanal aniqlanmadi. Kanaldan xabar forward qiling yoki @username yuboring.");
  }

  try {
    const chat = await ctx.telegram.getChat(targetChatId);
    if (chat.type !== 'channel') {
      return ctx.reply('❌ Bu kanal emas. Faqat kanal qo\'shish mumkin.');
    }

    // Bot shu kanalda admin ekanligini tekshiramiz (aks holda obunani tekshira olmaymiz)
    const me = await ctx.telegram.getMe();
    const botMember = await ctx.telegram.getChatMember(chat.id, me.id);
    if (!['administrator', 'creator'].includes(botMember.status)) {
      return ctx.reply(
        "❌ Bot bu kanalda administrator emas.\n" +
        "Iltimos, botni kanalga administrator qilib qo'shing va qaytadan urinib ko'ring."
      );
    }

    // Taklif havolasini olish (agar public bo'lsa username orqali, aks holda invite link yaratamiz)
    let inviteLink;
    if (chat.username) {
      inviteLink = `https://t.me/${chat.username}`;
    } else {
      inviteLink = await ctx.telegram.exportChatInviteLink(chat.id);
    }

    const exists = db.forceSubChannels.some((ch) => String(ch.chatId) === String(chat.id));
    if (exists) {
      delete waitingFor[ctx.from.id];
      return ctx.reply('ℹ️ Bu kanal allaqachon ro\'yxatda.', mainMenu);
    }

    db.forceSubChannels.push({
      chatId: chat.id,
      username: chat.username ? `@${chat.username}` : null,
      title: chat.title,
      inviteLink,
    });
    save(db);
    delete waitingFor[ctx.from.id];
    ctx.reply(`✅ Kanal qo'shildi: ${chat.title}`, mainMenu);
  } catch (err) {
    console.error('Kanal qo\'shishda xatolik:', err.message);
    ctx.reply(
      "❌ Kanalni topib bo'lmadi. Bot kanalda admin ekanligiga va username/ID to'g'riligiga ishonch hosil qiling."
    );
  }
}

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
async function main() {
  // 1) MongoDB ga ulanamiz
  await db_module.connect(process.env.MONGODB_URI);

  // 2) Saqlangan holatni yuklaymiz
  db = await db_module.load();
  if (!Array.isArray(db.forceSubChannels)) db.forceSubChannels = [];
  if (!db.groups) db.groups = {};
  if (!Array.isArray(db.admins)) db.admins = [];

  // 3) .env dagi admin ID larni qo'shamiz (agar hali yo'q bo'lsa)
  const envAdmins = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  let adminsChanged = false;
  envAdmins.forEach((id) => {
    if (!db.admins.includes(id)) {
      db.admins.push(id);
      adminsChanged = true;
    }
  });
  if (adminsChanged) await save(db);

  // 4) Broadcast tsiklini boshlaymiz
  restartBroadcastLoop();

  // 5) Bot ishga tushirish: Render'da webhook, lokal muhitda polling
  const PORT = process.env.PORT || 3000;
  const PUBLIC_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;

  if (PUBLIC_URL) {
    // ---- Webhook rejimi (Render / boshqa server) ----
    const app = express();
    const webhookPath = `/telegraf/${bot.secretPathComponent()}`;

    app.use(express.json());
    app.use(bot.webhookCallback(webhookPath));

    // Render "health check" so'rovlari uchun oddiy javob
    app.get('/', (req, res) => res.send('🤖 Auto Habar Bot ishlayapti.'));

    app.listen(PORT, async () => {
      const fullUrl = `${PUBLIC_URL.replace(/\/$/, '')}${webhookPath}`;
      await bot.telegram.setWebhook(fullUrl);
      console.log(`🤖 Auto Habar Bot webhook rejimida ishga tushdi: ${fullUrl}`);
      console.log(`🌐 Server ${PORT}-portda tinglayapti.`);
    });
  } else {
    // ---- Polling rejimi (lokal ishlab chiqish uchun) ----
    await bot.telegram.deleteWebhook().catch(() => {});
    await bot.launch();
    console.log('🤖 Auto Habar Bot polling rejimida ishga tushdi (lokal).');
  }
}

main().catch((err) => {
  console.error('❌ Botni ishga tushirishda xatolik:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
