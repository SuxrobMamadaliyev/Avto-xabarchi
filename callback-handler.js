const { Markup } = require("telegraf");
const db = require("./database");
const { getUserKeyboard, getAdminKeyboard } = require("./keyboards");
const { simpleName } = require("./helpers");

const ADMIN_ID = Number(process.env.ADMIN_ID);

async function handleCallback(ctx, userSessions) {
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;

  await ctx.answerCbQuery();

  // ---- Guruhlarni boshqarish ----
  if (data === "manage_groups") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.editMessageText("❌ Hech qanday hisob yo'q!");

    const buttons = [];
    let totalActive = 0, totalInactive = 0;

    for (const acc of accounts) {
      const groups = await db.getUserGroups(userId, acc.display_name);
      const active = groups.filter(g => g.is_active === 1).length;
      totalActive += active;
      totalInactive += groups.length - active;
      const status = acc.is_active === 1 ? "✅" : "❌";
      const sname = simpleName(acc.display_name);
      buttons.push([Markup.button.callback(
        `${status} ${sname} (${active} faol / ${groups.length} jami)`,
        `account_groups_${acc.display_name}`
      )]);
    }
    buttons.push([Markup.button.callback("🔙 Orqaga", "back_to_main")]);

    return ctx.editMessageText(
      `⚙️ **GURUHLARNI BOSHQARISH**\n\n📊 Umumiy: ${totalActive} faol / ${totalActive + totalInactive} jami\n\nHisobni tanlang:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
    );
  }

  // ---- Hisob guruhlari ----
  if (data.startsWith("account_groups_")) {
    const displayName = data.replace("account_groups_", "");
    return showAccountGroups(ctx, userId, displayName);
  }

  // ---- Guruh detail ----
  if (data.startsWith("group_detail_")) {
    const groupId = data.replace("group_detail_", "");
    return showGroupDetail(ctx, userId, groupId);
  }

  if (data.startsWith("group_activate_")) {
    const groupId = data.replace("group_activate_", "");
    const group = await db.getGroupById(groupId);
    if (!group) return ctx.editMessageText("❌ Guruh topilmadi!");
    await db.updateGroupActiveStatus([groupId], 1);
    await ctx.answerCbQuery("✅ Guruh faollashtirildi!");
    return showAccountGroups(ctx, userId, group.account_display_name);
  }

  if (data.startsWith("group_deactivate_")) {
    const groupId = data.replace("group_deactivate_", "");
    const group = await db.getGroupById(groupId);
    if (!group) return ctx.editMessageText("❌ Guruh topilmadi!");
    await db.updateGroupActiveStatus([groupId], 0);
    await ctx.answerCbQuery("❌ Guruh nofaollashtirildi!");
    return showAccountGroups(ctx, userId, group.account_display_name);
  }

  if (data.startsWith("group_delete_confirm_")) {
    const groupId = data.replace("group_delete_confirm_", "");
    const group = await db.getGroupById(groupId);
    if (!group) return ctx.editMessageText("❌ Guruh topilmadi!");

    return ctx.editMessageText(
      `⚠️ **TASDIQLASH**\n\n📢 **${group.group_title}** guruhini o'chirmoqchimisiz?\n\nBu amalni bekor qilib bo'lmaydi!`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Ha, o'chirish", `group_do_delete_${groupId}`)],
          [Markup.button.callback("❌ Bekor qilish", `account_groups_${group.account_display_name}`)],
        ]),
      }
    );
  }

  if (data.startsWith("group_do_delete_")) {
    const groupId = data.replace("group_do_delete_", "");
    const group = await db.getGroupById(groupId);
    if (!group) return ctx.editMessageText("❌ Guruh topilmadi!");
    const accountName = group.account_display_name;
    await db.deleteGroupById(groupId);
    await ctx.answerCbQuery("🗑️ Guruh o'chirildi!");
    return showAccountGroups(ctx, userId, accountName);
  }

  if (data.startsWith("enable_all_")) {
    const displayName = data.replace("enable_all_", "");
    const groups = await db.getUserGroups(userId, displayName);
    await db.updateGroupActiveStatus(groups.map(g => g.id), 1);
    await ctx.answerCbQuery("✅ Barcha guruhlar faollashtirildi!");
    return showAccountGroups(ctx, userId, displayName);
  }

  if (data.startsWith("disable_all_")) {
    const displayName = data.replace("disable_all_", "");
    const groups = await db.getUserGroups(userId, displayName);
    await db.updateGroupActiveStatus(groups.map(g => g.id), 0);
    await ctx.answerCbQuery("❌ Barcha guruhlar o'chirildi!");
    return showAccountGroups(ctx, userId, displayName);
  }

  // ---- Tugatish ----
  if (data === "finish_groups") {
    userSessions?.delete(userId);
    return ctx.editMessageText("✅ **Guruhlar muvaffaqiyatli qo'shildi!**\n\nEndi asosiy menyudan foydalanishingiz mumkin.", { parse_mode: "Markdown" });
  }

  // ---- Orqaga ----
  if (data === "back_to_main") {
    if (userId === ADMIN_ID) {
      await ctx.telegram.sendMessage(userId, "👑 **Admin Paneli**", { parse_mode: "Markdown", ...getAdminKeyboard() });
    } else {
      await ctx.telegram.sendMessage(userId, "🤖 **Asosiy menyu**", { parse_mode: "Markdown", ...getUserKeyboard() });
    }
    return ctx.deleteMessage();
  }

  // ---- Hisobni bekor qilish ----
  if (data === "cancel_add_account") {
    userSessions?.delete(userId);
    await ctx.editMessageText("❌ **Bekor qilindi!**\n\nHisob qo'shish bekor qilindi.", { parse_mode: "Markdown" });
    await ctx.telegram.sendMessage(userId, "🤖 **Asosiy menyu**", { parse_mode: "Markdown", ...getUserKeyboard() });
    return;
  }

  // ---- Hisoblarni ko'rish ----
  if (data === "view_accounts") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.editMessageText("📭 Hech qanday hisob yo'q!");

    let msg = "📋 **HISOBLAR RO'YXATI**\n\n";
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const status = acc.is_active === 1 ? "✅ Faol" : "❌ Nofaol";
      const sname = simpleName(acc.display_name);
      msg += `${i + 1}. **${sname}**\n   📞: +${acc.phone}\n   👤: @${acc.username || "Yoq"}\n   📊: ${status}\n\n`;
    }

    return ctx.editMessageText(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Orqaga", "back_to_accounts_menu")]]),
    });
  }

  if (data === "back_to_accounts_menu") {
    const accounts = await db.getUserAccounts(userId);
    return ctx.editMessageText(
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

  // ---- Hisob o'chirish menyusi ----
  if (data === "delete_account_menu") {
    const accounts = await db.getUserAccounts(userId);
    if (!accounts.length) return ctx.editMessageText("📭 Hech qanday hisob yo'q!");

    const buttons = accounts.map(acc => {
      const status = acc.is_active === 1 ? "✅" : "❌";
      const sname = simpleName(acc.display_name);
      return [Markup.button.callback(`${status} ${sname} (+${acc.phone})`, `confirm_delete_acc_${acc.display_name}`)];
    });
    buttons.push([Markup.button.callback("🔙 Orqaga", "back_to_accounts_menu")]);

    return ctx.editMessageText(
      "🗑️ **HISOBNI O'CHIRISH**\n\n⚠️ O'chirmoqchi bo'lgan hisobni tanlang:",
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
    );
  }

  if (data.startsWith("confirm_delete_acc_")) {
    const displayName = data.replace("confirm_delete_acc_", "");
    const sname = simpleName(displayName);
    return ctx.editMessageText(
      `⚠️ **TASDIQLASH**\n\n📱 **${sname}** hisobini o'chirmoqchimisiz?\n\nSession fayli va barcha guruhlar ham o'chiriladi!`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Ha, o'chirish", `do_delete_acc_${displayName}`)],
          [Markup.button.callback("❌ Bekor qilish", "delete_account_menu")],
        ]),
      }
    );
  }

  if (data.startsWith("do_delete_acc_")) {
    const displayName = data.replace("do_delete_acc_", "");
    const sname = simpleName(displayName);
    const success = await db.deleteUserAccount(userId, displayName);

    if (success) {
      await ctx.editMessageText(`✅ **${sname}** muvaffaqiyatli o'chirildi.\nSession fayli va barcha guruhlar tozalandi.`, { parse_mode: "Markdown" });
    } else {
      await ctx.editMessageText(`❌ **${sname}** hisobini o'chirishda xatolik yuz berdi.`, { parse_mode: "Markdown" });
    }

    await ctx.telegram.sendMessage(userId, "🤖 **Asosiy menyu**", { parse_mode: "Markdown", ...getUserKeyboard() });
    return;
  }

  // ---- Xabarlarni tozalash ----
  if (data === "confirm_clear_messages") {
    const deleted = await db.deleteUserMessages(userId);
    await ctx.editMessageText(
      `✅ **XABARLAR TOZALANDI!**\n\n🗑️ ${deleted} ta xabar bazadan o'chirildi.\n📦 Arxiv kanaldagi media fayllar saqlanib qoladi.`,
      { parse_mode: "Markdown" }
    );
    await ctx.telegram.sendMessage(userId, "🤖 **Asosiy menyu**", { parse_mode: "Markdown", ...getUserKeyboard() });
    return;
  }
}

// ---- HELPERS ----

async function showAccountGroups(ctx, userId, displayName) {
  const groups = await db.getUserGroups(userId, displayName);
  const sname = simpleName(displayName);

  if (!groups.length) {
    return ctx.editMessageText(
      `❌ ${sname} hisobida guruh yo'q!`,
      { ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Orqaga", "manage_groups")]]) }
    );
  }

  const activeCount = groups.filter(g => g.is_active === 1).length;
  const buttons = groups.map(group => {
    const status = group.is_active === 1 ? "✅" : "❌";
    let label = `${status} ${group.group_title}`;
    if (group.group_username) label += ` (@${group.group_username})`;
    if (label.length > 40) label = label.slice(0, 37) + "...";
    return [Markup.button.callback(label, `group_detail_${group.id}`)];
  });

  buttons.push([
    Markup.button.callback("✅ Hammasini yoqish", `enable_all_${displayName}`),
    Markup.button.callback("❌ Hammasini o'chirish", `disable_all_${displayName}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Orqaga", "manage_groups")]);

  return ctx.editMessageText(
    `⚙️ **${sname} - GURUHLAR**\n\n📊 ${activeCount} faol / ${groups.length - activeCount} nofaol / ${groups.length} jami\n\n✅ - faol | ❌ - nofaol\n\nGuruhni tanlang:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
  );
}

async function showGroupDetail(ctx, userId, groupId) {
  const group = await db.getGroupById(groupId);
  if (!group) return ctx.editMessageText("❌ Guruh topilmadi!");

  const { account_display_name, group_id, group_title, group_username, is_active } = group;
  const status = is_active === 1 ? "✅ Faol" : "❌ Nofaol";
  const usernameText = group_username ? `\n🔗 Username: @${group_username}` : "";

  return ctx.editMessageText(
    `📢 **GURUH MA'LUMOTLARI**\n\n📱 Hisob: ${simpleName(account_display_name)}\n📢 Guruh: ${group_title}${usernameText}\n🆔 ID: ${group_id}\n🔧 Status: ${status}\n\nAmal tanlang:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Faol qilish", `group_activate_${groupId}`)],
        [Markup.button.callback("❌ Nofaol qilish", `group_deactivate_${groupId}`)],
        [Markup.button.callback("🗑️ O'chirish", `group_delete_confirm_${groupId}`)],
        [Markup.button.callback("🔙 Bekor qilish", `account_groups_${account_display_name}`)],
      ]),
    }
  );
}

module.exports = { handleCallback };
