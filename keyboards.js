const { Markup } = require("telegraf");

function getAdminKeyboard() {
  return Markup.keyboard([
    ["📋 Foydalanuvchilar", "⏳ So'rovlar"],
    ["➕ Ruxsat berish", "🗑️ Hisob o'chirish"],
    ["📊 Statistika", "⚙️ Sozlamalar"],
    ["🔄 Session boshqarish", "🔄 Avtomatik yuborish"],
    ["⏸️ To'xtatish", "🔄 Yangilash"],
    ["📢 Xabar yuborish"],
    ["📌 Kanal ID o'rnatish (Ixtiyoriy)"],
  ]).resize();
}

function getUserKeyboard() {
  return Markup.keyboard([
    ["➕ Hisob qo'shish", "🧪 Session test"],
    ["📤 Xabar qo'shish", "🔗 Guruh qo'shish"],
    ["👥 Guruhlarni ko'rish", "⚙️ Interval sozlash"],
    ["🎲 Random rejim", "▶️ Boshlash"],
    ["⏹️ To'xtatish", "📋 Hisoblar"],
    ["📝 Xabarlar", "🗑️ Xabarlarni tozalash"],
    ["📊 Statistika"],
  ]).resize();
}

module.exports = { getAdminKeyboard, getUserKeyboard };
