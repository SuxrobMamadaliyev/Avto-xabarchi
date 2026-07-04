require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const db = require("./database");
const { initSessionsDir, enterCode, enterPassword, testSession } = require("./telegram-client");
const { getAdminKeyboard, getUserKeyboard } = require("./keyboards");
const { handleAdminText, processAddCommand, processRejectCommand, processRemoveCommand } = require("./admin-handler");
const { handleUserText, handleMediaMessage } = require("./user-handler");
const { handleCallback } = require("./callback-handler");
const { autoSendLoop, getState } = require("./auto-sender");
const { isSubscriptionActive, daysLeft } = require("./helpers");

const ADMIN_ID = Number(process.env.ADMIN_ID);
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || "sessions";
const STORAGE_CHANNEL_USERNAME = process.env.STORAGE_CHANNEL_USERNAME;

const bot = new Telegraf(BOT_TOKEN);
const userSessions = new Map();

// ========== /start ==========
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const { username, first_name, last_name } = ctx.from;

  if (userId === ADMIN_ID) {
    const pending = await db.getPendingRequests();
    await ctx.reply(
      `👑 **Admin Paneli**\n\n📊 Jami foydalanuvchilar: ${(await db.getAllUsers()).length}\n⏳ Kutilayotgan so'rovlar: ${pending.length}\n📦 Arxiv kanal: ${await db.getStorageChannel()}\n\nKerakli bo'limni tanlang:`,
      { parse_mode: "Markdown", ...getAdminKeyboard() }
    );
    for (const req of pending) {
      const id = req.id;
      const uname = req.username ? `@${req.username}` : "Yo'q";
      try {
        await ctx.reply(
          `⚠️ **KUTILAYOTGAN SO'ROV**\n\n👤 ${req.first_name} ${req.last_name || ""}\n🔗 ${uname}\n🆔 ID: ${req.user_id}\n\n✅ /add ${req.user_id} 30\n❌ /reject ${id}`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
    return;
  }

  const { subscriptionEnd } = await db.getUserSubscription(userId);
  const hasActive = isSubscriptionActive(subscriptionEnd);

  if (hasActive) {
    const accounts = await db.getUserAccounts(userId);
    const { min, max } = await db.getUserInterval(userId);
    return ctx.reply(
      `✅ **Obuna aktiv!**\n\n👋 Xush kelibsiz, ${first_name}!\n📅 Qolgan kunlar: ${daysLeft(subscriptionEnd)} kun\n📊 Hisoblar: ${accounts.length}/5 ta\n⏱️ Interval: ${min}-${max} daqiqa\n📦 Media saqlash: Arxiv kanalida\n\n🤖 Bot funksiyalaridan foydalaning:`,
      { parse_mode: "Markdown", ...getUserKeyboard() }
    );
  }

  const welcomeMsg = await db.getSetting("welcome_message", "🤖 Botdan foydalanish uchun ruxsat kerak!\n\nℹ️ Ruxsat olish uchun @Okean_manager ga murojaat qiling.");
  await ctx.reply(welcomeMsg);

  const requestId = await db.addRequest(userId, username, first_name, last_name || "");
  if (requestId) {
    try {
      await ctx.telegram.sendMessage(
        ADMIN_ID,
        `📩 **YANGI SO'ROV!**\n\n👤 ${first_name} ${last_name || ""}\n🔗 @${username || "Yoq"}\n🆔 ID: ${userId}\n\n✅ /add ${userId} 30\n❌ /reject ${requestId}`,
        { parse_mode: "Markdown" }
      );
    } catch {}
    await ctx.reply("✅ **So'rovingiz qabul qilindi!**\n\nAdmin tez orada ruxsat beradi.\n📩 @Okean_manager", { parse_mode: "Markdown" });
  } else {
    await ctx.reply("ℹ️ **Sizning so'rovingiz hali ko'rib chiqilmoqda.**\n\nAdmin javobini kuting.", { parse_mode: "Markdown" });
  }
});

// ========== /cancel ==========
bot.command("cancel", (ctx) => {
  userSessions.delete(ctx.from.id);
  return ctx.from.id === ADMIN_ID
    ? ctx.reply("❌ Bekor qilindi!", getAdminKeyboard())
    : ctx.reply("❌ Bekor qilindi!", getUserKeyboard());
});

// ========== /add /reject /remove ==========
bot.command("add", (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  return processAddCommand(ctx, ctx.message.text);
});

bot.command("reject", (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  return processRejectCommand(ctx, ctx.message.text);
});

bot.command("remove", (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  return processRemoveCommand(ctx, ctx.message.text);
});

// ========== /code ==========
bot.command("code", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Faqat admin uchun!");
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length !== 2) return ctx.reply("❌ Format: /code DISPLAY_NAME KOD");

  const [displayName, code] = args;
  await ctx.reply(`⏳ Kod kiritilmoqda: ${displayName}...`);

  const { success, message } = await enterCode(displayName, code);
  await db.logSessionAction(displayName, "enter_code", success ? "success" : "failed", message);
  await ctx.reply(`📝 **KOD NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });

  if (success) {
    const targetUserId = await db.getUserByDisplayName(displayName);
    if (targetUserId) {
      try {
        await ctx.telegram.sendMessage(
          targetUserId,
          `🎉 **HISOBINGIZ FAOL QILINDI!**\n\n📱 Hisob: ${displayName.split("_").pop()}\n✅ Status: Faol\n\nEndi guruh qo'shishingiz mumkin!`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
  }
});

// ========== /password ==========
bot.command("password", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Faqat admin uchun!");
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length !== 2) return ctx.reply("❌ Format: /password DISPLAY_NAME PAROL");

  const [displayName, password] = args;
  await ctx.reply(`⏳ Parol kiritilmoqda: ${displayName}...`);

  const { success, message } = await enterPassword(displayName, password);
  await db.logSessionAction(displayName, "enter_password", success ? "success" : "failed", message);
  await ctx.reply(`📝 **PAROL NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });

  if (success) {
    const targetUserId = await db.getUserByDisplayName(displayName);
    if (targetUserId) {
      try {
        await ctx.telegram.sendMessage(
          targetUserId,
          `🔐 **2FA PAROL TASDIQLANDI!**\n\n📱 Hisob: ${displayName.split("_").pop()}\n✅ Status: To'liq faol`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
  }
});

// ========== /test ==========
bot.command("test", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Faqat admin uchun!");
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (args.length !== 1) return ctx.reply("❌ Format: /test DISPLAY_NAME");

  await ctx.reply(`⏳ Session test qilinmoqda: ${args[0]}...`);
  const { success, message } = await testSession(args[0]);
  await db.logSessionAction(args[0], "test_session", success ? "success" : "failed", message);
  return ctx.reply(`📝 **TEST NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });
});

// ========== TEXT HANDLER ==========
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  if (userId === ADMIN_ID) {
    return handleAdminText(ctx, ctx.message.text, userSessions);
  }
  return handleUserText(ctx, ctx.message.text, userSessions);
});

// ========== MEDIA HANDLERS ==========
for (const type of ["photo", "video", "document", "audio", "voice", "sticker", "animation", "video_note"]) {
  bot.on(type, (ctx) => handleMediaMessage(ctx, userSessions));
}

// ========== CALLBACK ==========
bot.on("callback_query", (ctx) => handleCallback(ctx, userSessions));

// ========== EXPRESS + WEBHOOK (Render uchun) ==========
const app = express();
app.use(express.json());

// Health check — Render bu endpoint orqali bot ishlayotganini tekshiradi
app.get("/", (req, res) => {
  const state = getState();
  res.json({
    status: "running",
    bot: "Telegram Admin Bot",
    autoSend: state.isSending,
    lastSend: state.lastSendTime,
    time: new Date().toISOString(),
  });
});

// ========== ISHGA TUSHIRISH ==========
async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("🤖 TELEGRAM ADMIN BOT (Node.js + MongoDB + Render)");
  console.log("=".repeat(60));

  // MongoDB ga ulash
  await db.connectDB();

  // Sessions papkasini yaratish
  initSessionsDir();

  // Auto send loopni ishga tushirish
  autoSendLoop().catch(console.error);

  if (WEBHOOK_DOMAIN) {
    // === WEBHOOK rejimi (Render uchun) ===
    const webhookPath = `/webhook/${BOT_TOKEN}`;
    const webhookUrl = `${WEBHOOK_DOMAIN}${webhookPath}`;

    // Webhook handler
    app.use(bot.webhookCallback(webhookPath));

    // Serverni ishga tushirish
    app.listen(PORT, async () => {
      console.log(`🌐 Express server: port ${PORT}`);
      console.log(`🔗 Webhook URL: ${webhookUrl}`);

      // Webhookni o'rnatish
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log("✅ Webhook muvaffaqiyatli o'rnatildi!");
      } catch (e) {
        console.error("❌ Webhook o'rnatishda xato:", e.message);
      }
    });
  } else {
    // === POLLING rejimi (local development uchun) ===
    app.listen(PORT, () => {
      console.log(`🌐 Express server: port ${PORT} (health check uchun)`);
    });

    await bot.telegram.deleteWebhook();
    console.log("🔄 Polling rejimida ishlamoqda...");
    bot.launch({ allowedUpdates: ["message", "callback_query"] });
  }

  console.log(`✅ Sessions papkasi: ${SESSIONS_DIR}`);
  console.log(`📦 Arxiv kanal: ${STORAGE_CHANNEL_USERNAME}`);
  console.log(`👑 Admin ID: ${ADMIN_ID}`);
  console.log("=".repeat(60));
  console.log("\n🎯 KOMMANDALAR:");
  console.log("  /add ID KUNLAR       - Ruxsat berish");
  console.log("  /reject REQUEST_ID   - So'rovni rad etish");
  console.log("  /remove ID           - Foydalanuvchini o'chirish");
  console.log("  /code NAME KOD       - SMS kodini kiritish");
  console.log("  /password NAME PAROL - 2FA parolini kiritish");
  console.log("  /test NAME           - Sessionni test qilish");
  console.log("=".repeat(60));
}

main().catch(e => {
  console.error("❌ Bot ishga tushishda xato:", e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
