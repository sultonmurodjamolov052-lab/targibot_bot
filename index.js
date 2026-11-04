
require("dotenv").config();

const { spawn } = require("child_process");
const path = require("path");

const processes = [
    {
        name: "Telegram bot",
        file: path.join(__dirname, "src", "TG_bot", "index.js"),
    },
    {
        name: "Admin panel",
        file: path.join(__dirname, "src", "admin", "index.js"),
    },
];

const children = [];

for (const item of processes) {
    const child = spawn(process.execPath, [item.file], {
        cwd: __dirname,
        stdio: "inherit",
        env: process.env,
    });

    children.push(child);

    child.on("error", (error) => {
        console.error(`${item.name} xatosi:`, error.message);
    });

    child.on("exit", (code) => {
        console.log(`${item.name} to‘xtadi. Kod: ${code}`);
    });
}

function stopAll() {
    for (const child of children) {
        if (child.exitCode === null && !child.killed) {
            child.kill();
        }
    }
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

console.log("Telegram bot va admin panel ishga tushirilmoqda...");




// require('dotenv').config();
// const { Telegraf } = require('telegraf');

// const bot = new Telegraf(process.env.BOT_TOKEN);

// // 18 ta tayyor kamchilik
// const issues = [
//     "Xonadon devor pech orqali isitiladi.",
//     "Devor pech gazga ulangan.",
//     "Devor pech o‘tin bilan isitiladi.",
//     "Devor pech ko‘mir bilan isitiladi.",
//     "Devor pech dudburoni tozalanmagan.",
//     "Devor pechda yoriqlar bor. (Dalolatnoma so‘raladi).",
//     "Xonadon AGV pech orqali isitiladi.",
//     "Tomda yonuvchi materiallar bor (uy buyumlari, somon-xashak).",
//     "Xonadonda nosoz rozetka mavjud.",
//     "Rozetkaga bir nechta iste'molchi ulangan.",
//     "Nosoz elektr qurilmasidan foydalanilmoqda.",
//     "Nostandart elektr qurilmasidan foydalanilmoqda.",
//     "Nostandart gaz jihozidan foydalanilmoqda.",
//     "Suyultirilgan ballon xona (oshxona) ichida.",
//     "Suyultirilgan ballon tomda yoki yerto‘lada saqlanmoqda.",
//     "Xonadon tarqon pechdan foydalanilmoqda.",
//     "Gaz tarmog‘iga rezina shlang orqali ulangan.",
//     "Elektr simi rezinasi ochiq holatda foydalanilmoqda."
// ];

// // Hozircha vaqtinchalik xotira
// const selections = new Map();

// // Har bir odam va Topic uchun alohida kalit
// function getKey(ctx) {
//     const threadId = ctx.message.message_thread_id || 0;

//     return `${ctx.chat.id}:${threadId}:${ctx.from.id}`;
// }

// // Keyboard yaratish
// function getKeyboard(selected) {
//     const keyboard = issues.map((item, i) => [
//         `${selected.has(i) ? '✅' : '⬜️'} ${i + 1}. ${[
//             'Devor pech orqali isitiladi',
//             'Devor pech gazga ulangan',
//             'Devor pech o‘tin bilan isitiladi',
//             'Devor pech ko‘mir bilan isitiladi',
//             'Pech dudburoni tozalanmagan',
//             'Pechda yoriqlar bor',
//             'AGV pech orqali isitiladi',
//             'Tomda yonuvchi materiallar bor',
//             'Nosoz rozetka mavjud',
//             'Rozetkaga bir nechta iste’molchi ulangan',
//             'Nosoz elektr qurilmasi',
//             'Nostandart elektr qurilmasi',
//             'Nostandart gaz jihozi',
//             'Ballon xona ichida',
//             'Ballon tomda yoki yerto‘lada',
//             'Tarqon pechdan foydalaniladi',
//             'Gazga rezina shlang ulangan',
//             'Elektr simi ochiq holatda'
//         ][i]}`
//     ]);

//     keyboard.push(
//         ['📤 Hisobotni yuborish'],
//         ['🧹 Tozalash', '❌ Yopish']
//     );

//     return {
//         keyboard,
//         resize_keyboard: true,
//         selective: true
//     };
// }

// // Panelni ko‘rsatish
// bot.command('panel', async (ctx) => {
//     const key = getKey(ctx);

//     selections.set(key, new Set());

//     await ctx.telegram.sendMessage(
//         ctx.chat.id,
//         "🔥 Yong‘inga qarshi qaratilgan tadbirlar\n\nKerakli kamchiliklarni belgilang:",
//         {
//             reply_to_message_id: ctx.message.message_id,
//             ...(ctx.message.message_thread_id
//                 ? { message_thread_id: ctx.message.message_thread_id }
//                 : {}),
//             reply_markup: getKeyboard(selections.get(key))
//         }
//     );
// });

// // Tugmalarni boshqarish
// bot.on('text', async (ctx) => {
//     const text = ctx.message.text;
//     const key = getKey(ctx);

//     if (!selections.has(key)) return;

//     const selected = selections.get(key);

//     const options = {
//         reply_to_message_id: ctx.message.message_id,
//         ...(ctx.message.message_thread_id
//             ? { message_thread_id: ctx.message.message_thread_id }
//             : {})
//     };

//     // Kamchilik tanlash
//     const match = text.match(/^(⬜️|✅)\s*(\d+)\./);

//     if (match) {
//         const index = Number(match[2]) - 1;

//         if (index >= 0 && index < issues.length) {
//             if (selected.has(index)) {
//                 selected.delete(index);
//             } else {
//                 selected.add(index);
//             }

//             await ctx.telegram.sendMessage(
//                 ctx.chat.id,
//                 `Tanlangan kamchiliklar: ${selected.size} ta`,
//                 {
//                     ...options,
//                     reply_markup: getKeyboard(selected)
//                 }
//             );
//         }

//         return;
//     }

//     // Hisobot yuborish
//     if (text === '📤 Hisobotni yuborish') {
//         if (selected.size === 0) {
//             return ctx.reply("Avval kamida bitta kamchilikni tanlang.");
//         }

//         const report = [
//             "🏠 UY HOLATI BO‘YICHA HISOBOT",
//             "",
//             `👤 Xodim: ${ctx.from.first_name}`,
//             "",
//             "🔥 YONG‘INGA QARSHI ANIQLANGAN KAMCHILIKLAR:",
//             "",
//             ...[...selected]
//                 .sort((a, b) => a - b)
//                 .map(i => `${i + 1}. ${issues[i]}`),
//             "",
//             `📅 Sana: ${new Date().toLocaleDateString('uz-UZ')}`
//         ].join('\n');

//         await ctx.telegram.sendMessage(
//             ctx.chat.id,
//             report,
//             options
//         );

//         selections.delete(key);

//         await ctx.reply("✅ Hisobot yuborildi.", {
//             reply_markup: { remove_keyboard: true }
//         });

//         return;
//     }

//     // Tozalash
//     if (text === '🧹 Tozalash') {
//         selected.clear();

//         await ctx.telegram.sendMessage(
//             ctx.chat.id,
//             "Tanlovlar tozalandi. Qaytadan belgilang:",
//             {
//                 ...options,
//                 reply_markup: getKeyboard(selected)
//             }
//         );

//         return;
//     }

//     // Keyboardni yopish
//     if (text === '❌ Yopish') {
//         selections.delete(key);

//         await ctx.reply("Keyboard yopildi.", {
//             reply_markup: { remove_keyboard: true }
//         });
//     }
// });

// bot.launch()
//     .then(() => console.log("Bot ishga tushdi!"))
//     .catch(console.error);

// process.once('SIGINT', () => bot.stop('SIGINT'));
// process.once('SIGTERM', () => bot.stop('SIGTERM'));
