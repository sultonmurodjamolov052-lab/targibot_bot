require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const { message } = require('telegraf/filters');
const {
    createDocumentWithPhotos,
    getDocument,
    getDocumentPhotos,
    updateDocument,
    updateDocumentWithPhotos,
    deleteDocument,
    getTodayDocumentsByUser,
} = require('../../Elements/crud/SQLite');

// ---------- Sozlamalar ----------
const MAX_HOUSES_PER_DAY = 20;         // kuniga eng ko'pi bilan 20 ta uy
const MAX_PHOTOS_PER_HOUSE = 4;        // bitta uyga eng ko'pi bilan 4 ta rasm
const MAX_PHOTO_BYTES = 600 * 1024;    // bitta rasm hajmi (Firestore limiti uchun)
const ALBUM_WAIT_MS = 1500;            // albomdagi rasmlarning hammasi kelishini kutish
const TZ = 'Asia/Tashkent';

const BTN_HISTORY = "📜 Ma'lumotlar tarixi";
const BTN_STOP = "⛔ To'xtatish";
const BTN_RESTART = '🔄 Restart';
const mainKeyboard = Markup.keyboard([[BTN_HISTORY], [BTN_STOP, BTN_RESTART]]).resize();

const OPTIONS = [
    "Xonadon devor pech orqali isitiladi",
    "Devor pech gazga ulangan",
    "Devor pech o‘tin bilan isitiladi",
    "Devor pech ko‘mir bilan isitiladi",
    "Devor pech dudburoni tozalanmagan",
    "Devor pechda yoriqlar bor",
    "Xonadon AGV pech orqali isitiladi",
    "Tomda yonuvchi materiallar bor",
    "Xonadonda nosoz rozetka mavjud",
    "Rozetkaga bir nechta iste'molchi ulangan",
    "Nosoz elektr qurilmasidan foydalanilmoqda",
    "Nostandart elektr qurilmasidan foydalanilmoqda",
    "Nostandart gaz jihozidan foydalanilmoqda",
    "Suyultirilgan ballon xona (oshxona) ichida",
    "Suyultirilgan ballon tomda yoki yerto‘lada saqlanmoqda",
    "Xonadon tarqon pechdan foydalanilmoqda",
    "Gaz tarmog‘iga rezina shlang orqali ulangan",
    "Elektr simi rezinasi ochiq holatda foydalanilmoqda"
];

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Albom (bir vaqtda yuborilgan rasmlar) yig'ish uchun
const albums = new Map();

// ---------- Yordamchi funksiyalar ----------
// Sessiyani qayta tayinlash (obyektning o'zini almashtirmasdan)
function setSession(ctx, data = {}) {
    for (const k of Object.keys(ctx.session)) delete ctx.session[k];
    Object.assign(ctx.session, data);
}

function listKeyboard(selected = []) {
    const rows = OPTIONS.map((name, i) => [
        Markup.button.callback(
            (selected.includes(name) ? '✅ ' : '⬜️ ') + name,
            `toggle:${i}`
        ),
    ]);
    rows.push([
        Markup.button.callback('➡️ Davom etish', 'next'),
        Markup.button.callback('❌ Bekor qilish', 'cancel'),
    ]);
    return Markup.inlineKeyboard(rows);
}

function photosKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('➡️ Davom etish', 'photos_done'),
            Markup.button.callback('❌ Bekor qilish', 'cancel'),
        ],
    ]);
}

function editChoiceKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🖼 Rasmlarni almashtirish', 'edit_photos')],
        [Markup.button.callback('⏭ Rasmlar o‘zgarmasin', 'keep_photos')],
        [Markup.button.callback('❌ Bekor qilish', 'cancel')],
    ]);
}

function recordKeyboard(id) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('🖼 Rasm', `photo:${id}`),
            Markup.button.callback("✏️ O'zgartirish", `edit:${id}`),
            Markup.button.callback("🗑 O'chirish", `del:${id}`),
        ],
    ]);
}

function pickPhoto(photos) {
    // kichikdan kattaga tartiblangan; limitga sig'adigan eng kattasini olamiz
    const fit = photos.filter((p) => (p.file_size || 0) <= MAX_PHOTO_BYTES);
    return fit.length ? fit[fit.length - 1] : photos[0];
}

async function photoToBase64(ctx, fileId) {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error('Rasmni yuklab bo‘lmadi: ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString('base64');
}

// Faqat o'zining yozuvini olish
async function getOwnDocument(ctx, id) {
    const doc = await getDocument(id);
    if (!doc || doc.telegramId !== ctx.from.id) return null;
    return doc;
}

async function safeEditMarkup(ctx, markup) {
    try {
        await ctx.editMessageReplyMarkup(markup);
    } catch (err) {
        const msg = String(err.description || err.message || '');
        if (!msg.includes('message is not modified')) throw err;
    }
}

function limitText() {
    return (
        `⚠️ Bugungi limit (${MAX_HOUSES_PER_DAY} ta uy) tugadi.\n` +
        `Yangi uy qo'shish uchun tarixdan eski yozuvni o'chiring yoki ertaga urinib ko'ring.`
    );
}

// ---------- /start ----------
bot.start((ctx) =>
    ctx.reply('Salom! Boshlash uchun uyning rasmini yuboring 📸', mainKeyboard)
);

// ---------- 🔄 Restart ----------
bot.hears(BTN_RESTART, async (ctx) => {
    setSession(ctx);
    await ctx.reply(
        '🔄 Bot qayta boshlandi. Joriy kiritish bekor qilindi (saqlangan ma’lumotlar o‘chmaydi).\n\n' +
        'Boshlash uchun uyning rasmini yuboring 📸',
        mainKeyboard
    );
});

// ---------- ⛔ To'xtatish ----------
bot.hears(BTN_STOP, async (ctx) => {
    if (!ctx.session?.step) {
        return ctx.reply("Hozir hech qanday jarayon yo'q. Boshlash uchun rasm yuboring 📸", mainKeyboard);
    }
    setSession(ctx);
    await ctx.reply("⛔ Ma'lumot kiritish to'xtatildi.\nQayta boshlash uchun rasm yuboring 📸", mainKeyboard);
});

// ---------- 1) Rasm(lar) qabul qilish ----------
bot.on(message('photo'), async (ctx) => {
    const chosen = pickPhoto(ctx.message.photo);
    const groupId = ctx.message.media_group_id;

    let files;

    if (groupId) {
        // Albom: birinchi kelgan update "yetakchi" bo'ladi, qolganlari shunchaki qo'shiladi
        const key = `${ctx.from.id}:${groupId}`;
        const existing = albums.get(key);

        if (existing) {
            existing.push(chosen.file_id);
            return;
        }

        albums.set(key, [chosen.file_id]);
        await sleep(ALBUM_WAIT_MS);
        files = albums.get(key);
        albums.delete(key);
    } else {
        files = [chosen.file_id];
    }

    await handleIncomingPhotos(ctx, files);
});

async function handleIncomingPhotos(ctx, files) {
    const s = ctx.session;

    // --- Rasm yig'ish bosqichi (yangi uy yoki tahrirda almashtirish) ---
    if (s.step === 'photos') {
        const remaining = MAX_PHOTOS_PER_HOUSE - s.photos.length;

        if (remaining <= 0) {
            return ctx.reply(
                `⚠️ Rasmlar soni to'ldi (${MAX_PHOTOS_PER_HOUSE}/${MAX_PHOTOS_PER_HOUSE}).\n➡️ Davom eting.`,
                photosKeyboard()
            );
        }

        if (files.length > remaining) {
            return ctx.reply(
                `⚠️ Bir vaqtda ${files.length} ta rasm yuborildi, lekin bitta uy uchun jami ` +
                `${MAX_PHOTOS_PER_HOUSE} tadan oshmasligi kerak (hozir ${s.photos.length} ta qabul qilingan).\n` +
                `Bu rasmlar qabul qilinmadi.\n\n` +
                `📸 Iltimos, ${remaining} tagacha rasmni qaytadan yuboring.`,
                photosKeyboard()
            );
        }

        s.photos.push(...files);
        return ctx.reply(
            `📸 ${files.length} ta rasm qabul qilindi (jami ${s.photos.length}/${MAX_PHOTOS_PER_HOUSE}).\n` +
            `Yana rasm yuborishingiz yoki davom etishingiz mumkin.`,
            photosKeyboard()
        );
    }

    // --- Boshqa bosqichda bo'lsa ---
    if (s.step) {
        return ctx.reply(
            "⚠️ Hozir boshqa yozuv kiritilyapti. Avval uni tugating yoki ⛔ To'xtatish / 🔄 Restart ni bosing.",
            mainKeyboard
        );
    }

    // --- Yangi uy ---
    if (files.length > MAX_PHOTOS_PER_HOUSE) {
        return ctx.reply(
            `⚠️ Bir vaqtda ${files.length} ta rasm yuborildi. Bitta uy uchun eng ko'pi bilan ` +
            `${MAX_PHOTOS_PER_HOUSE} ta rasm mumkin.\nRasmlar qabul qilinmadi.\n\n` +
            `📸 Iltimos, ${MAX_PHOTOS_PER_HOUSE} tagacha rasmni qaytadan yuboring.`,
            mainKeyboard
        );
    }

    const today = await getTodayDocumentsByUser(ctx.from.id);
    if (today.length >= MAX_HOUSES_PER_DAY) {
        return ctx.reply(limitText(), mainKeyboard);
    }

    setSession(ctx, {
        step: 'photos',
        photos: files,
        selected: [],
        address: null,
    });

    await ctx.reply('🏠 Yangi uy boshlandi.', mainKeyboard);
    await ctx.reply(
        `📸 ${files.length} ta rasm qabul qilindi (${files.length}/${MAX_PHOTOS_PER_HOUSE}).\n` +
        `Yana rasm yuborishingiz yoki davom etishingiz mumkin.`,
        photosKeyboard()
    );
}

// ---------- Rasmlar tugadi -> ro'yxat ----------
bot.action('photos_done', async (ctx) => {
    const s = ctx.session;
    if (s?.step !== 'photos') return ctx.answerCbQuery().catch(() => { });

    if (!s.photos.length) {
        return ctx.answerCbQuery('Kamida 1 ta rasm yuboring!', { show_alert: true });
    }

    await ctx.answerCbQuery().catch(() => { });
    s.step = 'select';
    await ctx.reply('Kerakli ma’lumotlarni tanlang:', listKeyboard(s.selected));
});

// ---------- 2) Ro'yxatdan tanlash ----------
bot.action(/^toggle:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    if (ctx.session?.step !== 'select') return;

    const name = OPTIONS[Number(ctx.match[1])];
    const sel = ctx.session.selected;
    const idx = sel.indexOf(name);
    if (idx === -1) sel.push(name);
    else sel.splice(idx, 1);

    await safeEditMarkup(ctx, listKeyboard(sel).reply_markup);
});

// ---------- 3) Davom etish -> manzil ----------
bot.action('next', async (ctx) => {
    if (ctx.session?.step !== 'select') return ctx.answerCbQuery().catch(() => { });

    if (ctx.session.selected.length === 0) {
        return ctx.answerCbQuery('Kamida bitta element tanlang!', { show_alert: true });
    }

    ctx.session.step = 'address';
    await ctx.answerCbQuery().catch(() => { });

    const current = ctx.session.editId && ctx.session.address
        ? `\nHozirgi manzil: ${ctx.session.address}`
        : '';
    await ctx.reply('🏠 Uy manzilini yozing:' + current);
});

// ---------- 📜 Tarix (faqat bugungi yozuvlar) ----------
bot.hears(BTN_HISTORY, async (ctx) => {
    const docs = await getTodayDocumentsByUser(ctx.from.id);

    if (docs.length === 0) {
        return ctx.reply("Bugun hali saqlangan yozuv yo'q. Boshlash uchun rasm yuboring 📸", mainKeyboard);
    }

    await ctx.reply(`📜 Bugungi yozuvlar: ${docs.length}/${MAX_HOUSES_PER_DAY}`, mainKeyboard);

    for (const [i, d] of docs.entries()) {
        // const time = d.createdAt?.toDate?.().toLocaleTimeString('ru-RU', {
        //     timeZone: TZ,
        //     hour: '2-digit',
        //     minute: '2-digit',
        // }) || '—';
        const time = d.createdAt
            ? new Date(d.createdAt).toLocaleTimeString('uz-UZ', {
                timeZone: 'Asia/Tashkent',
                hour: '2-digit',
                minute: '2-digit',
            })
            : '—';

        await ctx.reply(
            `${i + 1}) 🕒 ${time}\n` +
            `📋 ${(d.selected || []).join(', ')}\n` +
            `🏠 ${d.address}\n` +
            `📷 Rasmlar: ${d.photoCount || 1} ta`,
            recordKeyboard(d.id)
        );

        await sleep(60); // Telegram tezlik limitiga tushmaslik uchun
    }
});

// ---------- 🖼 Rasmlarni ko'rish ----------
bot.action(/^photo:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const id = ctx.match[1];

    const doc = await getOwnDocument(ctx, id);
    if (!doc) return ctx.reply('⚠️ Yozuv topilmadi.');

    let photos = await getDocumentPhotos(id);
    // Eski yozuvlar (rasm hujjatning o'zida saqlangan) uchun
    if (!photos.length && doc.photoBase64) photos = [doc.photoBase64];

    if (!photos.length) return ctx.reply("Bu yozuvda rasm yo'q.");

    if (photos.length === 1) {
        return ctx.replyWithPhoto({ source: Buffer.from(photos[0], 'base64') });
    }

    await ctx.replyWithMediaGroup(
        photos.map((b64) => ({
            type: 'photo',
            media: { source: Buffer.from(b64, 'base64') },
        }))
    );
});

// ---------- ✏️ O'zgartirish: avval rasm haqida so'raydi ----------
bot.action(/^edit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const id = ctx.match[1];

    const doc = await getOwnDocument(ctx, id);
    if (!doc) return ctx.reply('⚠️ Yozuv topilmadi.');

    setSession(ctx, {
        step: 'edit_choice',
        editId: id,
        selected: [...(doc.selected || [])],
        address: doc.address,
        photos: [],
        replacePhotos: false,
    });

    await ctx.reply(
        `✏️ Tahrirlash.\n📷 Hozirgi rasmlar: ${doc.photoCount || 1} ta.\n\nRasmlarni ham o'zgartirasizmi?`,
        editChoiceKeyboard()
    );
});

bot.action('edit_photos', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const s = ctx.session;
    if (s?.step !== 'edit_choice') return;

    s.replacePhotos = true;
    s.photos = [];
    s.step = 'photos';

    await ctx.reply(
        `📸 Yangi rasmlarni yuboring (1 tadan ${MAX_PHOTOS_PER_HOUSE} tagacha, albom qilib ham bo'ladi).\n` +
        `Eski rasmlar yangilari bilan almashtiriladi.`,
        photosKeyboard()
    );
});

bot.action('keep_photos', async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const s = ctx.session;
    if (s?.step !== 'edit_choice') return;

    s.step = 'select';
    await ctx.reply("Kerakli ma'lumotlarni qayta tanlang:", listKeyboard(s.selected));
});

// ---------- 🗑 O'chirish (avval tasdiq so'raydi) ----------
bot.action(/^del:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const id = ctx.match[1];

    await safeEditMarkup(
        ctx,
        Markup.inlineKeyboard([
            [
                Markup.button.callback("✅ Ha, o'chirish", `delok:${id}`),
                Markup.button.callback('↩️ Yo‘q', `delno:${id}`),
            ],
        ]).reply_markup
    );
});

bot.action(/^delno:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    await safeEditMarkup(ctx, recordKeyboard(ctx.match[1]).reply_markup);
});

bot.action(/^delok:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => { });
    const doc = await getOwnDocument(ctx, ctx.match[1]);
    if (!doc) return ctx.reply('⚠️ Yozuv topilmadi.');

    await deleteDocument(ctx.match[1]); // rasmlari bilan birga o'chadi
    await ctx.editMessageText("🗑 Yozuv o'chirildi.");
});

// ---------- 4) Matn qabul qilish (manzil) ----------
bot.on(message('text'), async (ctx) => {
    const s = ctx.session;
    if (!s?.step) return ctx.reply('Boshlash uchun rasm yuboring 📸');

    const text = ctx.message.text.trim();

    if (s.step === 'edit_choice') {
        return ctx.reply('Yuqoridagi tugmalardan birini tanlang.', editChoiceKeyboard());
    }

    if (s.step === 'photos') {
        return ctx.reply('Yana rasm yuboring yoki ➡️ Davom etish ni bosing.', photosKeyboard());
    }

    if (s.step === 'select') {
        return ctx.reply('Ro‘yxatdan tanlang va ➡️ Davom etish ni bosing.');
    }

    if (s.step === 'address') {
        s.address = text;
        s.step = 'confirm';

        let photoLine;
        if (!s.editId) photoLine = `📷 Rasmlar: ${s.photos.length} ta\n`;
        else if (s.replacePhotos) photoLine = `📷 Yangi rasmlar: ${s.photos.length} ta\n`;
        else photoLine = `📷 Rasmlar: o'zgarmaydi\n`;

        return ctx.reply(
            `Ma’lumotlarni tekshiring:\n\n` +
            photoLine +
            `📋 Tanlangan: ${s.selected.join(', ')}\n` +
            `🏠 Manzil: ${s.address}`,
            Markup.inlineKeyboard([
                [Markup.button.callback('✅ Saqlash', 'confirm')],
                [Markup.button.callback('❌ Bekor qilish', 'cancel')],
            ])
        );
    }
});

// ---------- 5) Saqlash (yangi yoki tahrir) ----------
bot.action('confirm', async (ctx) => {
    const s = ctx.session;
    if (s?.step !== 'confirm') return ctx.answerCbQuery().catch(() => { });

    s.step = 'saving'; // ikki marta bosilsa, ikkita yozuv yaratilmasin
    await ctx.answerCbQuery('Saqlanmoqda...').catch(() => { });

    try {
        if (s.editId) {
            // --- Tahrirlash ---
            const doc = await getOwnDocument(ctx, s.editId);
            if (!doc) {
                setSession(ctx);
                return ctx.editMessageText('⚠️ Yozuv topilmadi.');
            }

            if (s.replacePhotos) {
                const photosBase64 = await Promise.all(
                    s.photos.map((fileId) => photoToBase64(ctx, fileId))
                );

                await updateDocumentWithPhotos(
                    s.editId,
                    {
                        photoFileIds: s.photos,
                        selected: s.selected,
                        address: s.address,
                    },
                    photosBase64
                );
            } else {
                await updateDocument(s.editId, {
                    selected: s.selected,
                    address: s.address,
                });
            }

            await ctx.editMessageText('✅ Yozuv yangilandi!');
        } else {
            // --- Yangi uy ---
            const today = await getTodayDocumentsByUser(ctx.from.id);
            if (today.length >= MAX_HOUSES_PER_DAY) {
                setSession(ctx);
                return ctx.editMessageText(limitText());
            }

            const photosBase64 = await Promise.all(
                s.photos.map((fileId) => photoToBase64(ctx, fileId))
            );

            await createDocumentWithPhotos(
                {
                    telegramId: ctx.from.id,
                    username: ctx.from.username || null,
                    photoFileIds: s.photos,
                    selected: s.selected,
                    address: s.address,
                },
                photosBase64
            );

            await ctx.editMessageText('✅ Ma’lumotlar muvaffaqiyatli saqlandi!');
        }

        setSession(ctx);
    } catch (err) {
        console.error('❌ Saqlashda xato:', err);
        s.step = 'confirm'; // qayta urinib ko'rish mumkin bo'lsin
        await ctx.reply('❌ Saqlashda xatolik yuz berdi, qayta urinib ko‘ring.');
    }
});

// ---------- Bekor qilish ----------
bot.action('cancel', async (ctx) => {
    setSession(ctx);
    await ctx.answerCbQuery('Bekor qilindi').catch(() => { });
    await ctx.editMessageText('❌ Bekor qilindi. Qayta boshlash uchun rasm yuboring.');
});

bot.catch((err) => {
    const msg = String(err.description || err.message || '');
    if (msg.includes('message is not modified')) return;
    console.error('Bot xatosi:', err);
});

bot.launch().then(() => console.log('🤖 Bot ishga tushdi'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));