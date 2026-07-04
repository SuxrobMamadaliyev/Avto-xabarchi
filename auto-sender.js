const db = require("./database");
const { sendMessageToGroup } = require("./telegram-client");
const { randomInt } = require("./helpers");

// Global holat
const state = {
  isSending: false,
  lastSendTime: null,
};

function getState() { return state; }
function setIsSending(val) { state.isSending = val; }

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function autoSendLoop() {
  console.log("🔄 Avtomatik yuborish loopi ishga tushdi...");

  while (true) {
    try {
      if (state.isSending) {
        const users = db.getAllUsers();
        let totalSent = 0;
        let totalFailed = 0;

        for (const userId of users) {
          const { subscriptionEnd } = db.getUserSubscription(userId);

          if (!subscriptionEnd || new Date(subscriptionEnd) < new Date()) continue;

          const accounts = db.getUserAccounts(userId);
          const { min: userMin, max: userMax } = db.getUserInterval(userId);

          for (const acc of accounts) {
            const { display_name: displayName, is_active: isActive } = acc;

            if (isActive !== 1) continue;

            const groups = db.getUserGroups(userId, displayName);
            const activeGroups = groups.filter((g) => g.is_active === 1);

            if (!activeGroups.length) continue;

            const messages = db.getUserMessages(userId);
            if (!messages.length) continue;

            const msgData = db.getRandomUserMessage(userId);
            if (!msgData) continue;

            for (const group of activeGroups) {
              const groupId = group.group_id;

              const { success, message: result } = await sendMessageToGroup(displayName, groupId, msgData);

              const logText = msgData.text
                ? msgData.text.slice(0, 50)
                : `[${msgData.message_type}]`;

              if (success) {
                totalSent++;
                console.log(`✅ ${displayName} -> ${group.group_title}: ${logText}`);
              } else {
                totalFailed++;
                console.error(`❌ ${displayName} -> ${group.group_title}: ${result}`);
              }

              // Har bir xabar o'rtasida 3-8 soniya
              await sleep(randomInt(3000, 8000));
            }
          }

          // Foydalanuvchi uchun interval kutish
          if (totalSent > 0) {
            const delaySec = randomInt(userMin * 60, userMax * 60);
            console.log(`⏰ ${userId} uchun keyingi yuborishga ${Math.floor(delaySec / 60)} daqiqa...`);
            await sleep(delaySec * 1000);
          }
        }

        if (totalSent > 0 || totalFailed > 0) {
          state.lastSendTime = new Date().toTimeString().slice(0, 8);
          console.log(`📊 NATIJA: ${totalSent} ta yuborildi, ${totalFailed} ta xatolik`);
        } else {
          console.log("ℹ️ Hech qanday xabar yuborilmadi");
        }

        await sleep(60000);
      } else {
        await sleep(30000);
      }
    } catch (e) {
      console.error("Auto send loop xatosi:", e.message);
      await sleep(30000);
    }
  }
}

module.exports = { autoSendLoop, getState, setIsSending };
