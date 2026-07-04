const { Markup } = require("telegraf");
const db = require("./database");
const { getAdminKeyboard, getUserKeyboard } = require("./keyboards");
const { simpleName, isSubscriptionActive, daysLeft } = require("./helpers");
const { createAndAuthSession, enterCode, enterPassword, sessionFileExists } = require("./telegram-client");
const { getState, setIsSending } = require("./auto-sender");
const { saveMediaToChannel } = require("./admin-handler");

const ADMIN_ID = Number(process.env.ADMIN_ID);

async function handleUserText(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const mode = session.mode;
  const state = getState();

  // Obunani tekshirish
  const { subscriptionEnd } = await db.getUserSubscription(userId);
  const hasActive = isSubscriptionActive(subscriptionEnd);

  if (!hasActive) {
    const welcomeMsg = await db.getSetting("welcome_message", "🤖 Botdan foydalanish uchun ruxsat kerak!");
    await ctx.reply(welcomeMsg);

    const { username, first_name, last_name } = ctx.from;
    const requestId = await db.addRequest(userId, username, first_name, last_name || "");

    if (requestId) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_ID,
          `📩 **YANGI SO'ROV!**\n\n👤 ${first_name} ${last_name || ""}\n🔗 @${username || "Yoq"}\n🆔 ID: ${userId}\n\n✅ /add ${userId} 30\n❌ /reject ${requestId}`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }
    return;
  }

  // ---- Hisob qo'shish ----
  if (text === "➕ Hisob qo'shish") {
    const count = await db.getUserAccountsCount(userId);
    if (count >= 5) {
      return ctx.reply(
        `❌ **Hisob limitiga yetdingiz!**\n\nSizda allaqachon ${count} ta hisob mavjud.\nMaksimal 5 ta hisob.`,
        { parse_mode: "Markdown", ...getUserKeyboard() }
      );
    }
    userSessions.set(userId, { ...session, mode: "add_account" });
    return ctx.reply(
      `📱 **TELEFON RAQAM KIRITING**\n\nFormat: +998901234567\n📊 Sizda ${count}/5 ta hisob mavjud\n\nBekor: /cancel`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  }

  // ---- Session test ----
  if (text === "🧪 Session test") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.reply("❌ Hech qanday hisob yo'q!");

    let msg = "🔍 **SESSION HOLATI**\n\n";
    for (const acc of accounts) {
      const exists = sessionFileExists(acc.display_name);
      const sname = simpleName(acc.display_name);
      msg += `📱 **${sname}** (+${acc.phone})\n`;
      msg += `   📁 Session: ${exists ? "✅ Mavjud" : "❌ Yo'q"}\n`;
      msg += `   🔧 Status: ${acc.is_active === 1 ? "✅ Faol" : "❌ Nofaol"}\n\n`;
    }
    return ctx.reply(msg, { parse_mode: "Markdown", ...getUserKeyboard() });
  }

  // ---- Xabar qo'shish ----
  if (text === "📤 Xabar qo'shish") {
    userSessions.set(userId, { ...session, mode: "add_message" });
    return ctx.reply(
      "📝 **XABAR YUBORING**\n\nIstalgan turdagi xabar yuboring:\n📷 Rasm | 🎬 Video | 📄 Fayl\n🎵 Audio | 🎤 Ovozli | 🎨 Stiker\n🎞 GIF | 📝 Matn\n\n📦 Media fayllar arxiv kanalida saqlanadi.\n\nBekor: /cancel",
      { parse_mode: "Markdown" }
    );
  }

  // ---- Guruh qo'shish ----
  if (text === "🔗 Guruh qo'shish") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.reply("❌ **Avval hisob qo'shing!**", { parse_mode: "Markdown", ...getUserKeyboard() });

    const buttons = accounts.map(acc => [`📱 ${simpleName(acc.display_name)} (+${acc.phone})`]);
    buttons.push(["🔙 Orqaga"]);
    userSessions.set(userId, { ...session, mode: "select_account" });
    return ctx.reply("📱 **HISOB TANLANG**\n\nQaysi hisobga guruh qo'shmoqchisiz?", {
      parse_mode: "Markdown",
      ...Markup.keyboard(buttons).resize(),
    });
  }

  // ---- Guruhlarni ko'rish ----
  if (text === "👥 Guruhlarni ko'rish") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.reply("❌ Hech qanday hisob yo'q!");

    let msg = "👥 **GURUHLAR RO'YXATI**\n\n";
    for (const acc of accounts) {
      const groups = await db.getUserGroups(userId, acc.display_name);
      const activeCount = groups.filter(g => g.is_active === 1).length;
      msg += `📱 **${simpleName(acc.display_name)}** (+${acc.phone})\n   📊 Guruhlar: ${activeCount}/${groups.length} ta\n\n`;
    }

    return ctx.reply(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Guruhlarni boshqarish", "manage_groups")]]),
    });
  }

  // ---- Interval sozlash ----
  if (text === "⚙️ Interval sozlash") {
    const { min, max } = await db.getUserInterval(userId);
    userSessions.set(userId, { ...session, mode: "set_user_interval" });
    return ctx.reply(
      `⚙️ **INTERVAL SOZLASH**\n\nHozirgi interval: ${min}-${max} daqiqa\n\nYangi intervalni yuboring:\nFormat: min max\nMisol: 10 20\n\nBekor: /cancel`,
      { parse_mode: "Markdown" }
    );
  }

  // ---- Random rejim ----
  if (text === "🎲 Random rejim") {
    const current = session.randomMessages !== false;
    const newVal = !current;
    userSessions.set(userId, { ...session, randomMessages: newVal });
    return ctx.reply(`✅ Random rejim ${newVal ? "yoqildi" : "o'chirildi"}!\n\n${newVal ? "🎲 Random xabarlar yuboriladi" : "📝 Ketma-ket xabarlar yuboriladi"}`);
  }

  // ---- Boshlash ----
  if (text === "▶️ Boshlash") {
    setIsSending(true);
    const { min, max } = await db.getUserInterval(userId);
    const rand = session.randomMessages !== false;
    return ctx.reply(
      `✅ **Avtomatik yuborish boshlandi!**\n\n⏰ Interval: ${min}-${max} daqiqa\n🎲 Random: ${rand ? "✅" : "❌"}`,
      { parse_mode: "Markdown" }
    );
  }

  // ---- To'xtatish ----
  if (text === "⏹️ To'xtatish") {
    setIsSending(false);
    return ctx.reply("⏹️ **Avtomatik yuborish to'xtatildi!**", { parse_mode: "Markdown" });
  }

  // ---- Hisoblar ----
  if (text === "📋 Hisoblar") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.reply("📭 Hech qanday hisob yo'q!\n\nHisob qo'shish uchun '➕ Hisob qo'shish' tugmasini bosing.");

    return ctx.reply(
      `📋 **HISOBLAR**\n\n📊 Sizda ${accounts.length} ta hisob mavjud.\n\nKerakli amalni tanlang:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("👁 Hisoblarni ko'rish", "view_accounts")],
          [Markup.button.callback("🗑️ Hisobni o'chirish", "delete_account_menu")],
          [Markup.button.callback("🔙 Orqaga", "back_to_main")],
        ]),
      }
    );
  }

  // ---- Xabarlar ----
  if (text === "📝 Xabarlar") {
    const messages = await db.getUserMessages(userId);
    if (!messages.length) return ctx.reply("📭 Hech qanday xabar yo'q!");

    const typeIcons = {
      text: "📝", photo: "📷", video: "🎬", document: "📄",
      audio: "🎵", voice: "🎤", sticker: "🎨", animation: "🎞", video_note: "⭕",
    };

    let msg = "📝 **XABARLAR RO'YXATI**\n\n";
    for (let i = 0; i < Math.min(messages.length, 10); i++) {
      const m = messages[i];
      const icon = typeIcons[m.message_type] || "📦";
      const display = m.text ? m.text.slice(0, 40) + (m.text.length > 40 ? "..." : "") : `[${m.message_type?.toUpperCase()}]`;
      msg += `${i + 1}. ${icon} ${display}\n\n`;
    }
    if (messages.length > 10) msg += `\n... va yana ${messages.length - 10} ta xabar`;
    return ctx.reply(msg, { parse_mode: "Markdown" });
  }

  // ---- Xabarlarni tozalash ----
  if (text === "🗑️ Xabarlarni tozalash") {
    const messages = await db.getUserMessages(userId);
    if (!messages.length) return ctx.reply("📭 Hech qanday xabar yo'q!");

    return ctx.reply(
      `🗑️ **XABARLARNI TOZALASH**\n\n⚠️ Sizda ${messages.length} ta xabar mavjud.\nBarcha xabarlarni o'chirmoqchimisiz?\nBu amalni bekor qilib bo'lmaydi!`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Ha, tozalash", "confirm_clear_messages")],
          [Markup.button.callback("❌ Yo'q, bekor qilish", "back_to_main")],
        ]),
      }
    );
  }

  // ---- Statistika ----
  if (text === "📊 Statistika") {
    const accounts = await db.getUserAccounts(userId);
    let totalGroups = 0, activeGroups = 0;
    for (const acc of accounts) {
      const groups = await db.getUserGroups(userId, acc.display_name);
      totalGroups += groups.length;
      activeGroups += groups.filter(g => g.is_active === 1).length;
    }
    const messages = await db.getUserMessages(userId);
    const { min, max } = await db.getUserInterval(userId);

    let msg = "📊 **STATISTIKA**\n\n";
    msg += `📱 Hisoblar: ${accounts.length}/5 ta\n`;
    msg += `👥 Faol guruhlar: ${activeGroups}/${totalGroups} ta\n`;
    msg += `📝 Xabarlar: ${messages.length} ta\n`;
    msg += `📅 Obuna: ${daysLeft(subscriptionEnd)} kun qoldi\n`;
    msg += `⏱️ Interval: ${min}-${max} daqiqa\n`;
    msg += `📦 Media saqlash: Arxiv kanalida\n`;
    msg += `🔄 Yuborish: ${state.isSending ? "✅ Yoqilgan" : "❌ O'chirilgan"}`;

    return ctx.reply(msg, { parse_mode: "Markdown" });
  }

  // ---- Hisob tanlash (guruh qo'shish uchun) ----
  if (mode === "select_account" && text.startsWith("📱 ")) {
    const parts = text.slice(2).split(" (+");
    const sname = parts[0].trim();
    const accounts = await db.getUserAccounts(userId);
    const acc = accounts.find(a => simpleName(a.display_name) === sname);
    if (!acc) return ctx.reply("❌ Hisob topilmadi!");

    userSessions.set(userId, { ...session, mode: "add_groups", selectedAccount: acc.display_name });
    return ctx.reply(
      `✅ **${sname} tanlandi!**\n\nEndi guruhlarni yuboring:\n• Har bir guruh alohida qatorda\n• @guruh_nomi yoki https://t.me/guruh_nomi\n\nBekor: /cancel`,
      { parse_mode: "Markdown" }
    );
  }

  // ---- Orqaga ----
  if (text === "🔙 Orqaga") {
    userSessions.delete(userId);
    return ctx.reply("🤖 **Asosiy menyu**", { parse_mode: "Markdown", ...getUserKeyboard() });
  }

  if (text === "/cancel") {
    userSessions.delete(userId);
    return ctx.reply("❌ **Bekor qilindi!**", { parse_mode: "Markdown", ...getUserKeyboard() });
  }

  // ---- Mode handlers ----
  if (mode === "add_account") return handleAddAccount(ctx, text, userSessions);
  if (mode === "add_message") return handleAddTextMessage(ctx, text, userSessions);
  if (mode === "add_groups") return handleAddGroups(ctx, text, userSessions);
  if (mode === "set_user_interval") return handleSetUserInterval(ctx, text, userSessions);
  if (mode === "enter_code") return handleEnterCode(ctx, text, userSessions);
  if (mode === "enter_password") return handleEnterPassword(ctx, text, userSessions);

  return ctx.reply("❌ Noma'lum buyruq! Menyudagi tugmalardan foydalaning yoki /start ni bosing.", getUserKeyboard());
}

// ========== MEDIA HANDLER ==========

async function handleMediaMessage(ctx, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  if (session.mode !== "add_message") return;

  const { subscriptionEnd } = await db.getUserSubscription(userId);
  if (!isSubscriptionActive(subscriptionEnd)) {
    return ctx.reply("❌ Obunangiz tugagan!", getUserKeyboard());
  }

  const storageChannel = await db.getStorageChannel();
  if (storageChannel === "not_set") {
    return ctx.reply("❌ **ARXIV KANALI SOZLANMAGAN!**", { parse_mode: "Markdown", ...getUserKeyboard() });
  }

  const msg = ctx.message;
  let messageType = null;

  if (msg.photo) messageType = "photo";
  else if (msg.video) messageType = "video";
  else if (msg.document) messageType = "document";
  else if (msg.audio) messageType = "audio";
  else if (msg.voice) messageType = "voice";
  else if (msg.sticker) messageType = "sticker";
  else if (msg.animation) messageType = "animation";
  else if (msg.video_note) messageType = "video_note";

  if (!messageType) {
    return ctx.reply("❌ Bu turdagi xabar qo'llab-quvvatlanmaydi!", getUserKeyboard());
  }

  const loadingMsg = await ctx.reply("⏳ Media arxivlanmoqda...");

  try {
    const { storageData, error } = await saveMediaToChannel(ctx, storageChannel);

    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch {}

    if (storageData) {
      const caption = msg.caption || "";
      await db.addUserMessage(userId, caption, messageType, storageData);

      const typeNames = {
        photo: "📷 Rasm", video: "🎬 Video", document: "📄 Fayl",
        audio: "🎵 Audio", voice: "🎤 Ovozli xabar", sticker: "🎨 Stiker",
        animation: "🎞 GIF", video_note: "⭕ Video xabar",
      };

      const captionText = caption ? `\n📝 Caption: ${caption.slice(0, 50)}...` : "";
      userSessions.set(userId, { ...session, mode: null });

      return ctx.reply(
        `✅ **XABAR QO'SHILDI!**\n\n📦 Turi: ${typeNames[messageType]}\n💾 Saqlandi: Arxiv kanalida${captionText}\n🔗 Manzil: ${storageData}`,
        { parse_mode: "Markdown", ...getUserKeyboard() }
      );
    } else {
      return ctx.reply(`❌ **XATOLIK!**\n\n${error || "Media arxivlashda xatolik."}`, {
        parse_mode: "Markdown", ...getUserKeyboard(),
      });
    }
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id); } catch {}
    return ctx.reply(`❌ **XATOLIK!**\n\n${e.message}`, { parse_mode: "Markdown", ...getUserKeyboard() });
  }
}

// ========== INTERNAL HANDLERS ==========

async function handleAddAccount(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};

  const count = await db.getUserAccountsCount(userId);
  if (count >= 5) {
    userSessions.delete(userId);
    return ctx.reply("❌ Hisob limitiga yetdingiz! Maksimum 5 ta hisob.", getUserKeyboard());
  }

  let phone = text.trim();
  if (phone.startsWith("+")) phone = phone.slice(1);

  if (!phone.startsWith("998") && !/^\d{11,12}$/.test(phone)) {
    return ctx.reply("❌ Noto'g'ri format! Misol: +998901234567");
  }

  const accountNumber = await db.getNextAccountNumber(userId);
  if (!accountNumber) {
    userSessions.delete(userId);
    return ctx.reply("❌ Hisob limitiga yetdingiz!", getUserKeyboard());
  }

  const displayName = `account_${userId}_${accountNumber}`;
  const result = await db.addUserAccount(userId, phone, "998", "", displayName);

  if (!result) {
    userSessions.delete(userId);
    return ctx.reply("❌ Hisob qo'shishda xatolik! Telefon raqam allaqachon mavjud.", getUserKeyboard());
  }

  await ctx.reply(
    `✅ **HISOB QO'SHILDI!**\n\n📱 Hisob: ${accountNumber}\n📞 Telefon: +${phone}\n\n⏳ Kod yuborilmoqda...`,
    { parse_mode: "Markdown" }
  );

  const { success, message } = await createAndAuthSession(userId, displayName, phone);

  if (success && message.startsWith("ENTER_CODE:")) {
    const pendingName = message.replace("ENTER_CODE:", "");
    userSessions.set(userId, { ...session, mode: "enter_code", pendingAccount: pendingName });
    return ctx.reply(
      `📱 **KOD YUBORILDI!**\n\n📞 +${phone} raqamiga SMS kod yuborildi.\n\nKodni kiriting:\n(Masalan: 12345)\n\nBekor: /cancel`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  } else if (success) {
    userSessions.delete(userId);
    return ctx.reply(`✅ **Hisob faollashtirildi!**\n\n${message}`, { parse_mode: "Markdown", ...getUserKeyboard() });
  } else {
    userSessions.delete(userId);
    return ctx.reply(`⚠️ **Session yaratishda xatolik:**\n\n${message}`, { parse_mode: "Markdown", ...getUserKeyboard() });
  }
}

async function handleAddTextMessage(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};

  await db.addUserMessage(userId, text, "text", null);
  userSessions.set(userId, { ...session, mode: null });

  return ctx.reply(
    `✅ **XABAR QO'SHILDI!**\n\n📦 Turi: 📝 Matn\n📄 Xabar: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
    { parse_mode: "Markdown", ...getUserKeyboard() }
  );
}

async function handleAddGroups(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const accountDisplayName = session.selectedAccount;

  if (!accountDisplayName) {
    userSessions.delete(userId);
    return ctx.reply("❌ Xatolik: Hisob tanlanmagan!", getUserKeyboard());
  }

  const groupsList = text.includes(",")
    ? text.split(",").map(s => s.trim()).filter(Boolean)
    : text.split("\n").map(s => s.trim()).filter(Boolean);

  if (!groupsList.length) return ctx.reply("❌ Hech qanday guruh kiritilmadi!");

  const { added, skipped } = await db.addGroupBatch(userId, accountDisplayName, groupsList);

  return ctx.reply(
    `📊 **NATIJALAR**\n\n✅ Qo'shildi: ${added} ta guruh\n⚠️ O'tkazib yuborildi: ${skipped} ta (mavjud)\n\nEndi nima qilmoqchisiz?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Tugatish", "finish_groups")],
        [Markup.button.callback("🔙 Orqaga", "back_to_main")],
      ]),
    }
  );
}

async function handleSetUserInterval(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return ctx.reply("❌ Format: min max\nMisol: 10 20");

  const minVal = parseInt(parts[0]);
  const maxVal = parseInt(parts[1]);
  if (isNaN(minVal) || isNaN(maxVal)) return ctx.reply("❌ Faqat raqam kiriting!");
  if (minVal <= 0 || maxVal <= 0) return ctx.reply("❌ Interval 0 dan katta bo'lishi kerak!");
  if (minVal >= maxVal) return ctx.reply("❌ Min interval max dan kichik bo'lishi kerak!");

  await db.saveUserInterval(userId, minVal, maxVal);
  userSessions.delete(userId);

  return ctx.reply(`✅ **Interval yangilandi!**\n\n📅 ${minVal}-${maxVal} daqiqa`, {
    parse_mode: "Markdown", ...getUserKeyboard(),
  });
}

async function handleEnterCode(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const code = text.trim();

  let pendingAccount = session.pendingAccount;
  if (!pendingAccount) {
    const pending = await db.getPendingSessionByUser(userId);
    if (pending) pendingAccount = pending.display_name;
  }

  if (!pendingAccount) {
    userSessions.delete(userId);
    return ctx.reply("❌ Kutilayotgan hisob topilmadi! Qaytadan hisob qo'shing.", getUserKeyboard());
  }

  await ctx.reply(`⏳ Kod tekshirilmoqda: ${pendingAccount}...`);

  const { success, message } = await enterCode(pendingAccount, code);

  if (success) {
    userSessions.delete(userId);
    return ctx.reply(
      `✅ **HISOB FAOLLASHTIRILDI!**\n\n📱 Hisob: ${simpleName(pendingAccount)}\n✅ Status: Faol\n\nEndi guruh qo'shishingiz mumkin!`,
      { parse_mode: "Markdown", ...getUserKeyboard() }
    );
  } else if (message === "2FA_NEEDED") {
    userSessions.set(userId, { ...session, mode: "enter_password", pendingAccount });
    return ctx.reply(
      `🔐 **2FA PAROL KERAK!**\n\n📱 Hisob: ${simpleName(pendingAccount)}\n\n2FA parolingizni kiriting:\n\nBekor: /cancel`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  } else {
    return ctx.reply(
      `❌ **KOD XATO!**\n\n${message}\n\nTo'g'ri kodni kiriting yoki /cancel bosing.`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  }
}

async function handleEnterPassword(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const pendingAccount = session.pendingAccount;

  if (!pendingAccount) {
    userSessions.delete(userId);
    return ctx.reply("❌ Kutilayotgan hisob topilmadi!", getUserKeyboard());
  }

  await ctx.reply(`⏳ Parol tekshirilmoqda: ${pendingAccount}...`);

  const { success, message } = await enterPassword(pendingAccount, text.trim());

  if (success) {
    userSessions.delete(userId);
    return ctx.reply(
      `✅ **HISOB TO'LIQ FAOLLASHTIRILDI!**\n\n📱 Hisob: ${simpleName(pendingAccount)}\n🔐 2FA parol tasdiqlandi\n✅ Status: To'liq faol`,
      { parse_mode: "Markdown", ...getUserKeyboard() }
    );
  } else {
    return ctx.reply(
      `❌ **PAROL XATO!**\n\n${message}\n\nTo'g'ri parolni kiriting yoki /cancel bosing.`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  }
}

module.exports = { handleUserText, handleMediaMessage };
