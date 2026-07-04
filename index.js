const { Telegraf } = require("telegraf");
const config = require("./src/config");
const db = require("./src/database");
const { initSessionsDir } = require("./src/telegram-client");
const { getAdminKeyboard, getUserKeyboard } = require("./src/keyboards");
const { handleAdminText, processAddCommand, processRejectCommand, processRemoveCommand } = require("./src/admin-handler");
const { handleUserText, handleMediaMessage } = require("./src/user-handler");
const { handleCallback } = require("./src/callback-handler");
const { autoSendLoop, getState } = require("./src/auto-sender");
const { enterCode, enterPassword, testSession, logSessionAction } = require("./src/telegram-client");
const { isSubscriptionActive, daysLeft } = require("./src/helpers");

// ========== INIT ==========
db.initDatabase();
initSessionsDir();

const bot = new Telegraf(config.BOT_TOKEN);

// Foydalanuvchi session holati (xotirada)
const userSessions = new Map();

// ========== /start ==========
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const { username, first_name, last_name } = ctx.from;

  if (userId === config.ADMIN_ID) {
    const pending = db.getPendingRequests();

    await ctx.reply(
      `👑 **Admin Paneli**\n\n📊 Jami foydalanuvchilar: ${db.getAllUsers().length}\n⏳ Kutilayotgan so'rovlar: ${pending.length}\n📦 Arxiv kanal: ${db.getStorageChannel()}\n\nKerakli bo'limni tanlang:`,
      { parse_mode: "Markdown", ...getAdminKeyboard() }
    );

    // Kutilayotgan so'rovlarni ko'rsatish
    for (const req of pending) {
      const uname = req.username ? `@${req.username}` : "Yo'q";
      try {
        await ctx.reply(
          `⚠️ **KUTILAYOTGAN SO'ROV**\n\n👤 ${req.first_name} ${req.last_name || ""}\n🔗 ${uname}\n🆔 ID: ${req.user_id}\n📅 ${req.created_at}\n\n✅ /add ${req.user_id} 30\n❌ /reject ${req.id}`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
    return;
  }

  // Oddiy foydalanuvchi
  const { subscriptionEnd } = db.getUserSubscription(userId);
  const hasActive = isSubscriptionActive(subscriptionEnd);

  if (hasActive) {
    const accounts = db.getUserAccounts(userId);
    const { min, max } = db.getUserInterval(userId);

    return ctx.reply(
      `✅ **Obuna aktiv!**\n\n👋 Xush kelibsiz, ${first_name}!\n📅 Qolgan kunlar: ${daysLeft(subscriptionEnd)} kun\n📊 Hisoblar: ${accounts.length}/5 ta\n⏱️ Interval: ${min}-${max} daqiqa\n📦 Media saqlash: Arxiv kanalida\n\n🤖 Bot funksiyalaridan foydalaning:`,
      { parse_mode: "Markdown", ...getUserKeyboard() }
    );
  } else {
    const welcomeMsg = db.getSetting("welcome_message", "🤖 Botdan foydalanish uchun ruxsat kerak!\n\nℹ️ Ruxsat olish uchun @Okean_manager ga murojaat qiling.");
    await ctx.reply(welcomeMsg);

    const requestId = db.addRequest(userId, username, first_name, last_name || "");
    if (requestId) {
      try {
        await ctx.telegram.sendMessage(
          config.ADMIN_ID,
          `📩 **YANGI SO'ROV!**\n\n👤 ${first_name} ${last_name || ""}\n🔗 @${username || "Yoq"}\n🆔 ID: ${userId}\n\n✅ /add ${userId} 30\n❌ /reject ${requestId}`,
          { parse_mode: "Markdown" }
        );
      } catch {}

      await ctx.reply("✅ **So'rovingiz qabul qilindi!**\n\nAdmin tez orada ruxsat beradi.\n📩 Xabar: @Okean_manager", { parse_mode: "Markdown" });
    } else {
      await ctx.reply("ℹ️ **Sizning so'rovingiz hali ko'rib chiqilmoqda.**\n\nAdmin javobini kuting.", { parse_mode: "Markdown" });
    }
  }
});

// ========== /cancel ==========
bot.command("cancel", (ctx) => {
  const userId = ctx.from.id;
  userSessions.delete(userId);
  if (userId === config.ADMIN_ID) {
    return ctx.reply("❌ Bekor qilindi!", getAdminKeyboard());
  }
  return ctx.reply("❌ Bekor qilindi!", getUserKeyboard());
});

// ========== /add /reject /remove ==========
bot.command("add", (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return;
  const rawText = ctx.message.text;
  return processAddCommand(ctx, rawText);
});

bot.command("reject", (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return;
  const rawText = ctx.message.text;
  return processRejectCommand(ctx, rawText);
});

bot.command("remove", (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return;
  const rawText = ctx.message.text;
  return processRemoveCommand(ctx, rawText);
});

// ========== /code ==========
bot.command("code", async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.reply("❌ Bu buyruq faqat admin uchun!");

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length !== 2) return ctx.reply("❌ Format: /code DISPLAY_NAME KOD\nMisol: /code account_123456789_1 12345");

  const [displayName, code] = args;
  await ctx.reply(`⏳ Kod kiritilmoqda: ${displayName}...`);

  const { success, message } = await enterCode(displayName, code);
  logSessionAction(displayName, "enter_code", success ? "success" : "failed", message);
  await ctx.reply(`📝 **KOD NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });

  if (success) {
    const targetUserId = db.getUserByDisplayName(displayName);
    if (targetUserId) {
      const sname = displayName.split("_").pop();
      try {
        await ctx.telegram.sendMessage(
          targetUserId,
          `🎉 **HISOBINGIZ FAOL QILINDI!**\n\n📱 Hisob: ${sname}\n✅ Status: Faol\n\nEndi guruh qo'shishingiz mumkin!`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
  }
});

// ========== /password ==========
bot.command("password", async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.reply("❌ Bu buyruq faqat admin uchun!");

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length !== 2) return ctx.reply("❌ Format: /password DISPLAY_NAME PAROL\nMisol: /password account_123456789_1 mypassword");

  const [displayName, password] = args;
  await ctx.reply(`⏳ Parol kiritilmoqda: ${displayName}...`);

  const { success, message } = await enterPassword(displayName, password);
  logSessionAction(displayName, "enter_password", success ? "success" : "failed", message);
  await ctx.reply(`📝 **PAROL NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });

  if (success) {
    const targetUserId = db.getUserByDisplayName(displayName);
    if (targetUserId) {
      const sname = displayName.split("_").pop();
      try {
        await ctx.telegram.sendMessage(
          targetUserId,
          `🔐 **2FA PAROL TASDIQLANDI!**\n\n📱 Hisob: ${sname}\n✅ Status: To'liq faol`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
  }
});

// ========== /test ==========
bot.command("test", async (ctx) => {
  if (ctx.from.id !== config.ADMIN_ID) return ctx.reply("❌ Bu buyruq faqat admin uchun!");

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length !== 1) return ctx.reply("❌ Format: /test DISPLAY_NAME\nMisol: /test account_123456789_1");

  const [displayName] = args;
  await ctx.reply(`⏳ Session test qilinmoqda: ${displayName}...`);

  const { success, message } = await testSession(displayName);
  logSessionAction(displayName, "test_session", success ? "success" : "failed", message);
  return ctx.reply(`📝 **TEST NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });
});

// ========== TEXT HANDLER ==========
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (userId === config.ADMIN_ID) {
    return handleAdminText(ctx, text, userSessions);
  } else {
    return handleUserText(ctx, text, userSessions);
  }
});

// ========== MEDIA HANDLERS ==========
const mediaFilter = ["photo", "video", "document", "audio", "voice", "sticker", "animation", "video_note"];

for (const type of mediaFilter) {
  bot.on(type, (ctx) => handleMediaMessage(ctx, userSessions));
}

// ========== CALLBACK HANDLER ==========
bot.on("callback_query", (ctx) => handleCallback(ctx, userSessions));

// ========== AUTO SEND LOOP ==========
autoSendLoop().catch(console.error);

// ========== START BOT ==========
console.log("\n" + "=".repeat(60));
console.log("🤖 TELEGRAM BOT ADMIN PANELI (Node.js)");
console.log("=".repeat(60));
console.log(`✅ Baza fayli: ${config.DB_FILE}`);
console.log(`✅ Sessions papkasi: ${config.SESSIONS_DIR}`);
console.log(`📦 Arxiv kanal: ${config.STORAGE_CHANNEL_USERNAME}`);
console.log(`👑 Admin ID: ${config.ADMIN_ID}`);
console.log(`📡 API ID: ${config.API_ID}`);
console.log("=".repeat(60));
console.log("\n🎯 KOMMANDALAR:");
console.log("  /add ID KUNLAR       - Ruxsat berish");
console.log("  /reject REQUEST_ID   - So'rovni rad etish");
console.log("  /remove ID           - Foydalanuvchini o'chirish");
console.log("  /code NAME KOD       - SMS kodini kiritish");
console.log("  /password NAME PAROL - 2FA parolini kiritish");
console.log("  /test NAME           - Sessionni test qilish");
console.log("=".repeat(60));

bot.launch({
  allowedUpdates: ["message", "callback_query"],
}).then(() => {
  console.log("\n🚀 Bot muvaffaqiyatli ishga tushdi!");
});

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
