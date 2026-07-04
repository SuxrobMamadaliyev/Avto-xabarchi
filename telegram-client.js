const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const fs = require("fs");
const path = require("path");
const db = require("./database");

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSIONS_DIR = process.env.SESSIONS_DIR || "sessions";

// ========== SESSION MANAGEMENT ==========

function initSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`📁 Sessions papkasi yaratildi: ${SESSIONS_DIR}`);
  }
}

function getStringSessionPath(displayName) {
  const safeName = displayName.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(SESSIONS_DIR, `${safeName}.txt`);
}

function loadStringSession(displayName) {
  const filePath = getStringSessionPath(displayName);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8").trim();
  }
  return "";
}

function saveStringSession(displayName, sessionString) {
  const filePath = getStringSessionPath(displayName);
  fs.writeFileSync(filePath, sessionString, "utf8");
}

function sessionFileExists(displayName) {
  return fs.existsSync(getStringSessionPath(displayName));
}

// ========== CLIENT YARATISH ==========

async function createClient(displayName) {
  const sessionString = loadStringSession(displayName);
  const session = new StringSession(sessionString);

  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    deviceModel: "Telegram Bot",
    systemVersion: "1.0",
    appVersion: "1.0",
    langCode: "en",
  });

  await client.connect();
  return client;
}

// ========== SESSION YARATISH VA AUTH ==========

async function createAndAuthSession(userId, displayName, phone) {
  try {
    if (phone.startsWith("+")) phone = phone.slice(1);

    const session = new StringSession("");
    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 3,
      deviceModel: "Telegram Bot",
      systemVersion: "1.0",
      appVersion: "1.0",
      langCode: "en",
    });

    await client.connect();

    if (!(await client.isUserAuthorized())) {
      const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, `+${phone}`);

      // Pending session saqlash
      await db.savePendingSession(displayName, phone, result.phoneCodeHash, userId);

      // Vaqtinchalik session (empty) saqlash
      const tempSession = client.session.save();
      saveStringSession(displayName, tempSession);

      await client.disconnect();

      return { success: true, message: `ENTER_CODE:${displayName}` };
    } else {
      const sessionStr = client.session.save();
      saveStringSession(displayName, sessionStr);
      await client.disconnect();

      await db.setAccountActive(displayName);

      return { success: true, message: "Session allaqachon avtorizatsiya qilingan" };
    }
  } catch (e) {
    console.error("createAndAuthSession xato:", e.message);
    const msg = e.message || String(e);
    if (msg.includes("FLOOD_WAIT")) {
      const sec = msg.match(/\d+/)?.[0] || "?";
      return { success: false, message: `Flood wait: ${sec} soniya kutish kerak` };
    }
    if (msg.includes("PHONE_NUMBER_INVALID")) {
      return { success: false, message: "Noto'g'ri telefon raqam" };
    }
    return { success: false, message: `Xato: ${msg}` };
  }
}

// ========== KOD KIRITISH ==========

async function enterCode(displayName, code) {
  try {
    const pending = await db.getPendingSession(displayName);
    if (!pending) return { success: false, message: "Kutilayotgan session topilmadi" };

    const { phone, code_hash: codeHash } = pending;

    const sessionString = loadStringSession(displayName);
    const session = new StringSession(sessionString);

    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 3,
    });

    await client.connect();

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: `+${phone}`,
          phoneCodeHash: codeHash,
          phoneCode: code,
        })
      );

      const newSession = client.session.save();
      saveStringSession(displayName, newSession);
      await client.disconnect();

      await db.removePendingSession(displayName);
      await db.setAccountActive(displayName);

      return { success: true, message: "✅ Session muvaffaqiyatli tasdiqlandi! Hisob endi faol." };
    } catch (e) {
      await client.disconnect();
      const msg = e.message || String(e);
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        return { success: false, message: `2FA_NEEDED` };
      }
      if (msg.includes("PHONE_CODE_INVALID")) {
        return { success: false, message: "❌ Noto'g'ri kod! Iltimos, to'g'ri kodni kiriting." };
      }
      return { success: false, message: `Kod kiritishda xato: ${msg}` };
    }
  } catch (e) {
    return { success: false, message: `Xato: ${e.message}` };
  }
}

// ========== 2FA PAROL ==========

async function enterPassword(displayName, password) {
  try {
    const sessionString = loadStringSession(displayName);
    if (!sessionString) return { success: false, message: "Session fayli topilmadi" };

    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 3,
    });

    await client.connect();

    try {
      await client.signInWithPassword(
        { apiId: API_ID, apiHash: API_HASH },
        { password: async () => password, onError: async (e) => { throw e; } }
      );

      const newSession = client.session.save();
      saveStringSession(displayName, newSession);
      await client.disconnect();

      await db.setAccountActive(displayName);

      return { success: true, message: "✅ 2FA parol tasdiqlandi! Hisob endi to'liq faol." };
    } catch (e) {
      await client.disconnect();
      return { success: false, message: `Parol noto'g'ri: ${e.message}` };
    }
  } catch (e) {
    return { success: false, message: `Xato: ${e.message}` };
  }
}

// ========== SESSION TEST ==========

async function testSession(displayName) {
  try {
    if (!sessionFileExists(displayName)) {
      return { success: false, message: "Session fayli topilmadi" };
    }

    const pending = await db.getPendingSession(displayName);
    const phone = pending?.phone || "";

    const client = await createClient(displayName);

    if (await client.isUserAuthorized()) {
      const me = await client.getMe();
      await client.disconnect();

      return {
        success: true,
        message: `✅ Session faol!\n👤 User: ${me.firstName} ${me.lastName || ""}\n📞 Phone: +${phone}\n🔗 Username: @${me.username || "Yoq"}`,
      };
    } else {
      await client.disconnect();
      return { success: false, message: "❌ Session avtorizatsiya qilinmagan" };
    }
  } catch (e) {
    return { success: false, message: `❌ Xato: ${e.message}` };
  }
}

// ========== GURUHGA XABAR YUBORISH ==========

async function sendMessageToGroup(displayName, groupIdentifier, messageData) {
  try {
    if (!sessionFileExists(displayName)) {
      return { success: false, message: "Session fayli topilmadi" };
    }

    const client = await createClient(displayName);

    if (!(await client.isUserAuthorized())) {
      await client.disconnect();
      return { success: false, message: "Session avtorizatsiya qilinmagan" };
    }

    try {
      // Guruhni topish
      let entity;
      try {
        if (groupIdentifier.startsWith("@")) {
          entity = await client.getEntity(groupIdentifier);
        } else if (groupIdentifier.startsWith("https://t.me/")) {
          const uname = groupIdentifier.split("/").pop();
          entity = await client.getEntity(`@${uname}`);
        } else if (groupIdentifier.startsWith("-100")) {
          entity = await client.getEntity(parseInt(groupIdentifier));
        } else {
          try {
            entity = await client.getEntity(`@${groupIdentifier}`);
          } catch {
            entity = await client.getEntity(parseInt(groupIdentifier));
          }
        }
      } catch {
        await client.disconnect();
        return { success: false, message: `Guruh topilmadi: ${groupIdentifier}` };
      }

      // Xabar yuborish
      if (typeof messageData === "string") {
        await client.sendMessage(entity, { message: messageData });
        await client.disconnect();
        return { success: true, message: `✅ Text xabar yuborildi: ${groupIdentifier}` };
      }

      if (typeof messageData === "object") {
        const { message_type, storage_data, text } = messageData;

        if (message_type === "text") {
          await client.sendMessage(entity, { message: text });
          await client.disconnect();
          return { success: true, message: `✅ Text xabar yuborildi: ${groupIdentifier}` };
        }

        if (storage_data) {
          const [chatIdStr, messageIdStr] = storage_data.split(":");
          const chatId = isNaN(Number(chatIdStr)) ? chatIdStr : parseInt(chatIdStr);
          const messageId = parseInt(messageIdStr);

          try {
            const storageChannel = await client.getEntity(chatId);
            const [msg] = await client.getMessages(storageChannel, { ids: [messageId] });

            if (msg) {
              const caption = text || undefined;
              if (msg.photo) {
                await client.sendFile(entity, { file: msg.photo, caption });
              } else if (msg.video) {
                await client.sendFile(entity, { file: msg.video, caption });
              } else if (msg.document) {
                await client.sendFile(entity, { file: msg.document, caption });
              } else if (msg.audio) {
                await client.sendFile(entity, { file: msg.audio, caption });
              } else if (msg.voice) {
                await client.sendFile(entity, { file: msg.voice, caption });
              } else if (msg.sticker) {
                await client.sendFile(entity, { file: msg.sticker });
              } else if (msg.gif) {
                await client.sendFile(entity, { file: msg.gif, caption });
              } else if (msg.videoNote) {
                await client.sendFile(entity, { file: msg.videoNote, caption });
              } else {
                if (text) await client.sendMessage(entity, { message: text });
                await client.disconnect();
                return { success: true, message: `⚠️ Faqat text yuborildi: ${groupIdentifier}` };
              }

              await client.disconnect();
              return { success: true, message: `✅ Media xabar yuborildi: ${groupIdentifier}` };
            } else {
              if (text) await client.sendMessage(entity, { message: text });
              await client.disconnect();
              return { success: false, message: `Arxiv kanalida xabar topilmadi: ${storage_data}` };
            }
          } catch (e) {
            if (text) {
              await client.sendMessage(entity, { message: text });
              await client.disconnect();
              return { success: true, message: `⚠️ Faqat text yuborildi (media xato): ${groupIdentifier}` };
            }
            await client.disconnect();
            return { success: false, message: `Fayl yuborib bo'lmadi: ${e.message}` };
          }
        } else {
          if (text) {
            await client.sendMessage(entity, { message: text });
            await client.disconnect();
            return { success: true, message: `✅ Text xabar yuborildi: ${groupIdentifier}` };
          }
          await client.disconnect();
          return { success: false, message: "Xabar ma'lumotlari noto'g'ri" };
        }
      }

      await client.disconnect();
      return { success: false, message: "Noma'lum xabar formati" };
    } catch (e) {
      await client.disconnect();
      return { success: false, message: `❌ Xabar yuborishda xato: ${e.message}` };
    }
  } catch (e) {
    return { success: false, message: `❌ Xato: ${e.message}` };
  }
}

module.exports = {
  initSessionsDir,
  sessionFileExists,
  createAndAuthSession,
  enterCode,
  enterPassword,
  testSession,
  sendMessageToGroup,
};
