const { Markup } = require("telegraf");
const db = require("./database");
const { getAdminKeyboard, getUserKeyboard } = require("./keyboards");
const { parseIdDays, parseSingleId, parseRequestId, simpleName, isSubscriptionActive, daysLeft } = require("./helpers");
const { createAndAuthSession, testSession, enterCode, enterPassword, sessionFileExists } = require("./telegram-client");
const { getState, setIsSending } = require("./auto-sender");

// ========== MEDIA ARXIV ==========

async function saveMediaToChannel(ctx, storageChannel) {
  const msg = ctx.message;
  const userId = ctx.from.id;
  const caption = msg.caption || "";
  const userCaption = `User: ${userId}`;
  const finalCaption = caption ? `${caption}\n\n${userCaption}` : userCaption;

  try {
    const sent = await ctx.telegram.copyMessage(storageChannel, msg.chat.id, msg.message_id, {
      caption: msg.sticker ? undefined : finalCaption,
    });
    return { storageData: `${storageChannel}:${sent.message_id}`, error: null };
  } catch (e) {
    return { storageData: null, error: `Media arxivlashda xato: ${e.message}` };
  }
}

// ========== ADMIN HANDLERS ==========

async function handleAdminText(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const mode = session.mode;
  const state = getState();

  // ---- Foydalanuvchilar ----
  if (text === "📋 Foydalanuvchilar") {
    const users = await db.getAllUsers();
    if (!users.length) return ctx.reply("📭 Hech qanday foydalanuvchi yo'q!");

    let msg = "📋 **FOYDALANUVCHILAR RO'YXATI**\n\n";
    for (let i = 0; i < Math.min(users.length, 20); i++) {
      const uid = users[i];
      const accounts = await db.getUserAccounts(uid);
      const { subscriptionEnd, isPremium } = await db.getUserSubscription(uid);
      const status = isPremium ? "✅ Premium" : subscriptionEnd ? "⏰ Aktiv" : "❌ Yo'q";

      msg += `${i + 1}. ID: ${uid}\n`;
      msg += `   📊 Hisoblar: ${accounts.length} ta\n`;
      msg += `   🔧 Status: ${status}\n`;
      if (subscriptionEnd && isSubscriptionActive(subscriptionEnd)) {
        msg += `   ⏰ Qolgan: ${daysLeft(subscriptionEnd)} kun\n`;
      }
      msg += "\n";
    }
    if (users.length > 20) msg += `\n... va yana ${users.length - 20} ta foydalanuvchi`;
    return ctx.reply(msg, { parse_mode: "Markdown" });
  }

  // ---- So'rovlar ----
  if (text === "⏳ So'rovlar") {
    const requests = await db.getPendingRequests();
    if (!requests.length) return ctx.reply("✅ Kutilayotgan so'rovlar yo'q!");

    for (const req of requests) {
      const { id, user_id, username, first_name, last_name, created_at } = req;
      const usernameDisplay = username ? `@${username}` : "Yo'q";
      await ctx.reply(
        `📩 **So'rov #${id}**\n👤 ${first_name} ${last_name}\n🔗 ${usernameDisplay}\n🆔 ID: ${user_id}\n📅 ${created_at}\n✅ /add ${user_id} 30\n❌ /reject ${id}`,
        { parse_mode: "Markdown" }
      );
    }
    await ctx.reply(`📊 Jami kutilayotgan so'rovlar: ${requests.length} ta`, getAdminKeyboard());
    return;
  }

  // ---- Ruxsat berish ----
  if (text === "➕ Ruxsat berish") {
    userSessions.set(userId, { ...session, mode: "grant_access" });
    return ctx.reply(
      "📝 **RUXSAT BERISH**\n\nFormat: ID KUNLAR\nMisol: 123456789 30\n\nBekor qilish: /cancel",
      { parse_mode: "Markdown" }
    );
  }

  // ---- Hisob o'chirish ----
  if (text === "🗑️ Hisob o'chirish") {
    userSessions.set(userId, { ...session, mode: "delete_user" });
    return ctx.reply(
      "🗑️ **HISOB O'CHIRISH**\n\nFoydalanuvchi ID sini yuboring:\nMisol: 123456789\n\nBekor qilish: /cancel",
      { parse_mode: "Markdown" }
    );
  }

  // ---- Statistika ----
  if (text === "📊 Statistika") {
    const users = await db.getAllUsers();
    let totalAccounts = 0, totalGroups = 0, totalMessages = 0;

    for (const uid of users) {
      totalAccounts += (await db.getUserAccounts(uid)).length;
      totalGroups += await db.getUserGroupsCount(uid);
      totalMessages += (await db.getUserMessages(uid)).length;
    }

    const requests = await db.getPendingRequests();
    let msg = "📊 **BOT STATISTIKASI**\n\n";
    msg += `👥 Foydalanuvchilar: ${users.length} ta\n`;
    msg += `📱 Jami hisoblar: ${totalAccounts} ta\n`;
    msg += `👥 Jami guruhlar: ${totalGroups} ta\n`;
    msg += `📝 Jami xabarlar: ${totalMessages} ta\n`;
    msg += `⏳ Kutilayotgan so'rovlar: ${requests.length} ta\n`;
    msg += `📦 Arxiv kanal: ${await db.getStorageChannel()}\n\n`;
    msg += `🔄 Avtomatik yuborish: ${state.isSending ? "✅ Yoqilgan" : "❌ O'chirilgan"}\n`;
    if (state.lastSendTime) msg += `⏰ Oxirgi yuborish: ${state.lastSendTime}\n`;

    return ctx.reply(msg, { parse_mode: "Markdown" });
  }

  // ---- Sozlamalar ----
  if (text === "⚙️ Sozlamalar") {
    const minI = await db.getSetting("min_interval", "20");
    const maxI = await db.getSetting("max_interval", "25");
    const rand = (await db.getSetting("random_messages", "true")) === "true";

    return ctx.reply(
      `⚙️ **BOT SOZLAMALARI**\n\n📅 Interval: ${minI}-${maxI} daqiqa\n🎲 Random: ${rand ? "✅ Yoqilgan" : "❌ O'chirilgan"}\n📦 Arxiv kanal: ${await db.getStorageChannel()}`,
      {
        parse_mode: "Markdown",
        ...Markup.keyboard([
          ["📅 Interval sozlash", "🎲 Random rejim"],
          ["📢 Xush kelib xabari", "📌 Arxiv kanali"],
          ["🔙 Orqaga"],
        ]).resize(),
      }
    );
  }

  if (text === "📅 Interval sozlash") {
    const minI = await db.getSetting("min_interval", "20");
    const maxI = await db.getSetting("max_interval", "25");
    userSessions.set(userId, { ...session, mode: "set_interval" });
    return ctx.reply(`📅 Hozirgi interval: ${minI}-${maxI} daqiqa\n\nYangi intervalni yuboring:\nFormat: min max\nMisol: 15 30\n\nBekor: /cancel`);
  }

  if (text === "🎲 Random rejim") {
    const current = (await db.getSetting("random_messages", "true")) === "true";
    const newVal = !current;
    await db.saveSetting("random_messages", String(newVal));
    return ctx.reply(`✅ Random rejim ${newVal ? "yoqildi" : "o'chirildi"}!\n\n${newVal ? "🎲 Random xabarlar yuboriladi" : "📝 Ketma-ket xabarlar yuboriladi"}`);
  }

  if (text === "📢 Xush kelib xabari") {
    const cur = await db.getSetting("welcome_message", "Botdan foydalanish uchun ruxsat kerak!");
    userSessions.set(userId, { ...session, mode: "set_welcome" });
    return ctx.reply(`📢 Hozirgi xabar:\n${cur}\n\nYangi xabarni yuboring:\n\nBekor: /cancel`);
  }

  if (text === "📌 Arxiv kanali" || text === "📌 Kanal ID o'rnatish (Ixtiyoriy)") {
    userSessions.set(userId, { ...session, mode: "set_storage_channel" });
    return ctx.reply(`📌 Hozirgi kanal: ${await db.getStorageChannel()}\n\nYangi kanal username ni yuboring:\nMisol: @my_storage_channel\n\nBekor: /cancel`);
  }

  if (text === "🔙 Orqaga") {
    userSessions.delete(userId);
    return ctx.reply("👑 **Admin Paneli**", { parse_mode: "Markdown", ...getAdminKeyboard() });
  }

  // ---- Session boshqarish ----
  if (text === "🔄 Session boshqarish") {
    const pending = await db.getAllPendingSessions();

    if (pending.length) {
      let msg = "⏳ **KUTILAYOTGAN SESSIONS**\n\n";
      for (const s of pending) {
        msg += `📱 ${s.display_name} (User: ${s.user_id})\n   📞 +${s.phone}\n   ⌨️ Kod: /code ${s.display_name} KOD\n\n`;
      }
      await ctx.reply(msg, { parse_mode: "Markdown" });
    } else {
      await ctx.reply("✅ Kutilayotgan sessionlar yo'q!");
    }

    const users = await db.getAllUsers();
    const buttons = [];
    for (const uid of users.slice(0, 10)) {
      const accounts = await db.getUserAccounts(uid);
      for (const acc of accounts) {
        const sname = simpleName(acc.display_name);
        const status = acc.is_active === 1 ? "✅" : "❌";
        buttons.push([`${status} ${sname} (${uid})`]);
      }
    }
    buttons.push(["🔙 Orqaga"]);
    userSessions.set(userId, { ...session, mode: "select_session_account" });
    return ctx.reply("🔄 **SESSION BOSHQARISH**\n\nHisobni tanlang:", {
      parse_mode: "Markdown",
      ...Markup.keyboard(buttons).resize(),
    });
  }

  // ---- Avtomatik yuborish ----
  if (text === "🔄 Avtomatik yuborish") {
    setIsSending(true);
    const minI = await db.getSetting("min_interval", "20");
    const maxI = await db.getSetting("max_interval", "25");
    const rand = (await db.getSetting("random_messages", "true")) === "true";
    return ctx.reply(`✅ **Avtomatik yuborish yoqildi!**\n\n⏰ Interval: ${minI}-${maxI} daqiqa\n🎲 Random: ${rand ? "✅" : "❌"}`, { parse_mode: "Markdown" });
  }

  if (text === "⏸️ To'xtatish") {
    setIsSending(false);
    return ctx.reply("⏸️ **Avtomatik yuborish to'xtatildi!**", { parse_mode: "Markdown" });
  }

  if (text === "🔄 Yangilash") {
    const pending = await db.getPendingRequests();
    return ctx.reply(
      `🔄 **YANGILANDI**\n\n📊 Foydalanuvchilar: ${(await db.getAllUsers()).length}\n⏳ Kutilayotgan so'rovlar: ${pending.length}\n📦 Arxiv kanal: ${await db.getStorageChannel()}`,
      { parse_mode: "Markdown", ...getAdminKeyboard() }
    );
  }

  // ---- Broadcast ----
  if (text === "📢 Xabar yuborish") {
    const activeUsers = await db.getAllActiveUserIds();
    userSessions.set(userId, { ...session, mode: "broadcast_message" });
    return ctx.reply(
      `📢 **XABAR YUBORISH**\n\n👥 Faol foydalanuvchilar: ${activeUsers.length} ta\n\nYubormoqchi bo'lgan xabaringizni yozing:\n\nBekor: /cancel`,
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  }

  // ---- Mode bo'yicha ----
  if (mode === "grant_access") return processGrantAccess(ctx, text, userSessions);
  if (mode === "delete_user") return processDeleteUser(ctx, text, userSessions);
  if (mode === "set_interval") return processSetInterval(ctx, text, userSessions);
  if (mode === "set_welcome") return processSetWelcome(ctx, text, userSessions);
  if (mode === "set_storage_channel") return processSetStorageChannel(ctx, text, userSessions);
  if (mode === "broadcast_message") return processBroadcast(ctx, text, userSessions);
  if (mode === "send_test_message") return processSendTestMessage(ctx, text, userSessions);

  // ---- Session account tanlash (tugmalar) ----
  if (mode === "select_session_account" && (text.startsWith("✅ ") || text.startsWith("❌ "))) {
    return handleSelectSessionAccount(ctx, text, userSessions);
  }
  if (mode === "manage_session") return handleManageSession(ctx, text, userSessions);

  if (text === "/cancel") {
    userSessions.delete(userId);
    return ctx.reply("❌ **Bekor qilindi!**", { parse_mode: "Markdown", ...getAdminKeyboard() });
  }

  return ctx.reply("❌ Noma'lum buyruq! Menyudagi tugmalardan foydalaning.", getAdminKeyboard());
}

// ========== PROCESS HELPERS ==========

async function processGrantAccess(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const [targetId, days] = parseIdDays(text);
  if (!targetId || !days) return ctx.reply("❌ Format: ID KUNLAR\nMisol: 123456789 30");
  if (days <= 0) return ctx.reply("❌ Kunlar soni 0 dan katta bo'lishi kerak!");

  const subEnd = await db.updateUserSubscription(targetId, days);
  if (!subEnd) return ctx.reply("❌ Ruxsat berishda xatolik!");

  const req = await db.getRequestByUserId(targetId);
  if (req) await db.updateRequestStatus(req.id, "approved", `Admin tomonidan ${days} kun ruxsat berildi`);

  try {
    await ctx.telegram.sendMessage(
      targetId,
      `🎉 **Tabriklaymiz!**\n\nSizga ${days} kunlik ruxsat berildi!\n⏰ Tugash: ${subEnd}\n\nYangilash uchun /start ni bosing.`,
      { parse_mode: "Markdown" }
    );
  } catch {}

  userSessions.delete(userId);
  return ctx.reply(`✅ **Ruxsat berildi!**\n\n👤 ID: ${targetId}\n📅 ${days} kun\n⏰ ${subEnd}`, {
    parse_mode: "Markdown", ...getAdminKeyboard(),
  });
}

async function processDeleteUser(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const targetId = parseSingleId(text);
  if (!targetId) return ctx.reply("❌ Noto'g'ri ID!");

  await db.deleteUserData(targetId);
  userSessions.delete(userId);

  try {
    await ctx.telegram.sendMessage(
      targetId,
      "⚠️ **Sizning hisobingiz o'chirildi!**\n\nQayta foydalanish uchun @Okean_manager ga murojaat qiling.",
      { parse_mode: "Markdown" }
    );
  } catch {}

  return ctx.reply(`✅ **Foydalanuvchi o'chirildi!**\n\n👤 ID: ${targetId}\n\nBarcha ma'lumotlar tozalandi.`, {
    parse_mode: "Markdown", ...getAdminKeyboard(),
  });
}

async function processSetInterval(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return ctx.reply("❌ Format: min max\nMisol: 15 30");

  const minVal = parseInt(parts[0]);
  const maxVal = parseInt(parts[1]);
  if (isNaN(minVal) || isNaN(maxVal)) return ctx.reply("❌ Faqat raqam kiriting!");
  if (minVal <= 0 || maxVal <= 0) return ctx.reply("❌ Interval 0 dan katta bo'lishi kerak!");
  if (minVal >= maxVal) return ctx.reply("❌ Min interval max dan kichik bo'lishi kerak!");

  await db.saveSetting("min_interval", String(minVal));
  await db.saveSetting("max_interval", String(maxVal));
  userSessions.delete(userId);
  return ctx.reply(`✅ **Interval yangilandi!**\n\n📅 ${minVal}-${maxVal} daqiqa`, {
    parse_mode: "Markdown", ...getAdminKeyboard(),
  });
}

async function processSetWelcome(ctx, text, userSessions) {
  const userId = ctx.from.id;
  await db.saveSetting("welcome_message", text);
  userSessions.delete(userId);
  return ctx.reply(`✅ **Xush kelib xabari yangilandi!**\n\n${text.slice(0, 200)}`, {
    parse_mode: "Markdown", ...getAdminKeyboard(),
  });
}

async function processSetStorageChannel(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const newChannel = text.trim();
  if (!newChannel.startsWith("@")) return ctx.reply("❌ Kanal @ bilan boshlanishi kerak!");

  try {
    const testMsg = await ctx.telegram.sendMessage(newChannel, "🤖 Bot test xabari...");
    await ctx.telegram.deleteMessage(newChannel, testMsg.message_id);
    await db.saveSetting("storage_channel", newChannel);
    userSessions.delete(userId);
    return ctx.reply(`✅ **Arxiv kanali yangilandi!**\n\n📦 ${newChannel}`, {
      parse_mode: "Markdown", ...getAdminKeyboard(),
    });
  } catch (e) {
    userSessions.delete(userId);
    return ctx.reply(`❌ **XATOLIK!**\nKanalga kirishda xatolik: ${e.message}\n\nBot kanalda admin bo'lishi kerak.`, {
      parse_mode: "Markdown", ...getAdminKeyboard(),
    });
  }
}

async function processBroadcast(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const activeUsers = await db.getAllActiveUserIds();

  if (!activeUsers.length) {
    userSessions.delete(userId);
    return ctx.reply("❌ Faol foydalanuvchilar yo'q!", getAdminKeyboard());
  }

  await ctx.reply(`📤 Xabar yuborilmoqda...\n👥 Jami: ${activeUsers.length} ta foydalanuvchi\n⏳ Iltimos kuting...`);

  let sent = 0, failed = 0;
  for (let i = 0; i < activeUsers.length; i++) {
    try {
      await ctx.telegram.sendMessage(activeUsers[i], `📢 **ADMIN XABARI**\n\n${text}`, { parse_mode: "Markdown" });
      sent++;
    } catch {
      failed++;
    }
    if ((i + 1) % 100 === 0) await new Promise(r => setTimeout(r, 1000));
    else await new Promise(r => setTimeout(r, 10));
  }

  userSessions.delete(userId);
  return ctx.reply(
    `✅ **XABAR YUBORILDI!**\n\n📤 Yuborildi: ${sent} ta\n❌ Xato: ${failed} ta\n👥 Jami: ${activeUsers.length} ta`,
    { parse_mode: "Markdown", ...getAdminKeyboard() }
  );
}

async function handleSelectSessionAccount(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const statusChar = text[0];
  const rest = text.slice(2);
  const match = rest.match(/^(.+?)\s+\((\d+)\)$/);
  if (!match) return ctx.reply("❌ Noto'g'ri format!");

  const sname = match[1].trim();
  const targetUserId = parseInt(match[2]);

  const accounts = await db.getUserAccounts(targetUserId);
  const acc = accounts.find(a => simpleName(a.display_name) === sname);
  if (!acc) return ctx.reply("❌ Hisob topilmadi!");

  const displayName = acc.display_name;
  userSessions.set(userId, { ...session, mode: "manage_session", sessionAccount: displayName, sessionUserId: targetUserId });

  const exists = sessionFileExists(displayName);
  const isActive = acc.is_active === 1;

  const buttons = [];
  if (!exists) buttons.push(["📱 Session yaratish"]);
  else {
    buttons.push(["🧪 Sessionni test qilish"]);
    if (isActive) buttons.push(["📤 Test xabar yuborish"]);
  }
  buttons.push(["🔙 Orqaga"]);

  return ctx.reply(
    `🔄 **SESSION BOSHQARISH**\n\n📱 Hisob: ${displayName}\n👤 User ID: ${targetUserId}\n📞 +${acc.phone}\n🔧 Status: ${isActive ? "✅ Faol" : "❌ Nofaol"}\n📁 Session: ${exists ? "Mavjud" : "Yo'q"}`,
    { parse_mode: "Markdown", ...Markup.keyboard(buttons).resize() }
  );
}

async function handleManageSession(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const displayName = session.sessionAccount;
  const targetUserId = session.sessionUserId;

  if (text === "📱 Session yaratish") {
    const accounts = await db.getUserAccounts(targetUserId);
    const acc = accounts.find(a => a.display_name === displayName);
    if (!acc?.phone) return ctx.reply("❌ Telefon raqam topilmadi!");

    await ctx.reply(`⏳ Session yaratilmoqda: ${displayName}...`);
    const { success, message } = await createAndAuthSession(targetUserId, displayName, acc.phone);

    if (success && message.startsWith("ENTER_CODE:")) {
      return ctx.reply(
        `✅ Kod yuborildi!\n\nKodni kiritish:\n\`/code ${displayName} KOD\``,
        { parse_mode: "Markdown" }
      );
    }
    return ctx.reply(`${success ? "✅" : "❌"} ${message}`);
  }

  if (text === "🧪 Sessionni test qilish") {
    await ctx.reply(`⏳ Test qilinmoqda: ${displayName}...`);
    const { success, message } = await testSession(displayName);
    return ctx.reply(`📝 **TEST NATIJASI**\n\n${message}`, { parse_mode: "Markdown" });
  }

  if (text === "📤 Test xabar yuborish") {
    userSessions.set(userId, { ...session, mode: "send_test_message" });
    return ctx.reply("📤 Guruh ID yoki username yuboring:\n@guruh_nomi\n\nBekor: /cancel");
  }

  if (text === "🔙 Orqaga") {
    userSessions.delete(userId);
    return ctx.reply("👑 **Admin Paneli**", { parse_mode: "Markdown", ...getAdminKeyboard() });
  }
}

async function processSendTestMessage(ctx, text, userSessions) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId) || {};
  const displayName = session.sessionAccount;

  await ctx.reply(`⏳ Test xabar yuborilmoqda...\nHisob: ${displayName}\nGuruh: ${text}`);
  const { sendMessageToGroup } = require("./telegram-client");
  const { success, message: result } = await sendMessageToGroup(displayName, text.trim(), "🤖 Test xabar - Bu bot tomonidan yuborilgan test xabari!");
  await ctx.reply(`📝 **TEST XABAR NATIJASI**\n\n${result}`, { parse_mode: "Markdown" });
  userSessions.set(userId, { ...session, mode: "manage_session" });
}

// ========== COMMANDS ==========

async function processAddCommand(ctx, rawText) {
  const [targetId, days] = parseIdDays(rawText);
  if (!targetId || !days) return ctx.reply("❌ Format: /add ID KUNLAR\nMisol: /add 123456789 30");
  if (days <= 0) return ctx.reply("❌ Kunlar soni 0 dan katta bo'lishi kerak!");

  const subEnd = await db.updateUserSubscription(targetId, days);
  if (!subEnd) return ctx.reply("❌ Ruxsat berishda xatolik!");

  const req = await db.getRequestByUserId(targetId);
  if (req) await db.updateRequestStatus(req.id, "approved", `${days} kun ruxsat berildi`);

  try {
    await ctx.telegram.sendMessage(
      targetId,
      `🎉 **Tabriklaymiz!**\n\nSizga ${days} kunlik ruxsat berildi!\n⏰ Tugash: ${subEnd}\n\nYangilash uchun /start ni bosing.`,
      { parse_mode: "Markdown" }
    );
  } catch {}

  return ctx.reply(`✅ **Ruxsat berildi!**\n\n👤 ID: ${targetId}\n📅 ${days} kun\n⏰ ${subEnd}`, {
    parse_mode: "Markdown", ...getAdminKeyboard(),
  });
}

async function processRejectCommand(ctx, rawText) {
  const requestId = parseRequestId(rawText);
  if (!requestId) return ctx.reply("❌ Format: /reject REQUEST_ID");

  const request = await db.getRequestById(requestId);
  if (!request) return ctx.reply(`❌ So'rov #${requestId} topilmadi!`);

  await db.updateRequestStatus(requestId, "rejected", "Admin tomonidan rad etildi");

  try {
    await ctx.telegram.sendMessage(
      request.user_id,
      `❌ **Sizning so'rovingiz rad etildi!**\n\nQayta urinish uchun @Okean_manager ga murojaat qiling.`,
      { parse_mode: "Markdown" }
    );
  } catch {}

  return ctx.reply(
    `✅ **So'rov rad etildi!**\n\n📝 #${requestId}\n👤 ${request.first_name} ${request.last_name}\n🆔 ${request.user_id}`,
    { parse_mode: "Markdown", ...getAdminKeyboard() }
  );
}

async function processRemoveCommand(ctx, rawText) {
  const targetId = parseSingleId(rawText);
  if (!targetId) return ctx.reply("❌ Format: /remove ID");

  await db.deleteUserData(targetId);

  try {
    await ctx.telegram.sendMessage(
      targetId,
      "⚠️ **Sizning hisobingiz o'chirildi!**\n\nQayta foydalanish uchun @Okean_manager ga murojaat qiling.",
      { parse_mode: "Markdown" }
    );
  } catch {}

  return ctx.reply(`✅ **Foydalanuvchi o'chirildi!**\n\n👤 ID: ${targetId}`, {
    parse_mode: "Markdown", ...getAdminKeyboard(),
  });
}

module.exports = {
  handleAdminText,
  saveMediaToChannel,
  processAddCommand,
  processRejectCommand,
  processRemoveCommand,
};
