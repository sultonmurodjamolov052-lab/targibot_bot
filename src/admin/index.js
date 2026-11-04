require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const {
    getDocument,
    getDocumentPhotos,
    queryDocuments,
    getStats,
} = require("../../Elements/crud/SQLite");

const app = express();
const PORT = Number(process.env.ADMIN_PORT) || 3001;
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 soat

if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    throw new Error(
        "ADMIN_PASSWORD va SESSION_SECRET .env faylida bo‘lishi kerak."
    );
}

// 1. CORS (cookie yo'q, shuning uchun credentials kerak emas)
app.use(cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

// 2. JSON
app.use(express.json({ limit: "1mb" }));

// ---------- TOKEN (imzolangan, server xotirasiga bog'liq emas) ----------
function hmac(payload) {
    return crypto
        .createHmac("sha256", process.env.SESSION_SECRET)
        .update(payload)
        .digest("base64url");
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of fails) {
        if (now - f.last > 5 * 60 * 1000) fails.delete(ip);
    }
}, 10 * 60 * 1000);

function signToken() {
    const payload = Buffer.from(
        JSON.stringify({ admin: true, exp: Date.now() + TOKEN_TTL_MS })
    ).toString("base64url");

    return `${payload}.${hmac(payload)}`;
}

function verifyToken(token) {
    if (typeof token !== "string") return false;

    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const [payload, signature] = parts;
    const a = Buffer.from(signature);
    const b = Buffer.from(hmac(payload));

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return data.admin === true && data.exp > Date.now();
    } catch {
        return false;
    }
}

function requireAdmin(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!verifyToken(token)) {
        return res.status(401).json({
            message: "Avval admin sifatida tizimga kiring.",
        });
    }

    next();
}

// ---------- Yordamchilar ----------
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDay(d) {
    return (
        typeof d === "string" &&
        DAY_RE.test(d) &&
        !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
    );
}

// Toshkent bo'yicha bugungi sana "YYYY-MM-DD"
function todayTashkent() {
    return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// async handlerlardagi xatolarni ushlaydi (aks holda so'rov osilib qoladi)
const handle = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((error) => {
        console.error(error);
        res.status(500).json({ message: "Serverda xatolik yuz berdi." });
    });

// ---------- LOGIN ----------
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const fails = new Map(); // ip -> { count, last }

app.post("/api/auth/login", (req, res) => {
    const ip = req.ip;
    const f = fails.get(ip);

    if (f && f.count >= 5 && Date.now() - f.last < 5 * 60 * 1000) {
        return res.status(429).json({
            success: false,
            message: "Juda ko‘p urinish. 5 daqiqadan keyin qayta urinib ko‘ring.",
        });
    }

    const ok = crypto.timingSafeEqual(
        sha256(req.body?.password ?? ""),
        sha256(process.env.ADMIN_PASSWORD)
    );

    if (!ok) {
        fails.set(ip, { count: (f?.count || 0) + 1, last: Date.now() });
        return res.status(401).json({
            success: false,
            message: "Parol noto‘g‘ri",
        });
    }

    fails.delete(ip);
    res.json({ success: true, token: signToken(), expiresIn: TOKEN_TTL_MS });
});

app.get("/api/auth/me", requireAdmin, (req, res) => {
    res.json({ authenticated: true });
});

// Token brauzerda o'chiriladi; serverda saqlanadigan narsa yo'q
app.post("/api/auth/logout", (req, res) => {
    res.json({ success: true });
});

// ---------- ARIZALAR RO'YXATI (kun / qidiruv / sahifalash) ----------
// GET /api/documents?date=2026-10-30&q=matn&telegramId=123&page=1&pageSize=20
app.get("/api/documents", requireAdmin, handle(async (req, res) => {
    const { date, q, telegramId } = req.query;

    if (date && !isValidDay(date)) {
        return res.status(400).json({ message: "Sana noto‘g‘ri (YYYY-MM-DD bo‘lishi kerak)." });
    }
    if (telegramId && !/^\d{1,20}$/.test(String(telegramId))) {
        return res.status(400).json({ message: "telegramId noto‘g‘ri." });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

    const { total, rows } = await queryDocuments({
        day: date || undefined,
        telegramId: telegramId || undefined,
        q: q ? String(q).slice(0, 100) : undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
    });

    res.json({ data: rows, total, page, pageSize });
}));

// ---------- BITTA ARIZA ----------
app.get("/api/documents/:id", requireAdmin, handle(async (req, res) => {
    const document = await getDocument(req.params.id);

    if (!document) {
        return res.status(404).json({ message: "Ariza topilmadi." });
    }

    res.json({ data: document });
}));

// ---------- ARIZA RASMLARI (base64) ----------
app.get("/api/documents/:id/photos", requireAdmin, handle(async (req, res) => {
    const document = await getDocument(req.params.id);

    if (!document) {
        return res.status(404).json({ message: "Ariza topilmadi." });
    }

    const photos = await getDocumentPhotos(req.params.id);
    res.json({ data: photos });
}));

// ---------- DASHBOARD STATISTIKASI ----------
// GET /api/stats?date=2026-10-30  (sana berilmasa, bugun)
app.get("/api/stats", requireAdmin, handle(async (req, res) => {
    const date = req.query.date || todayTashkent();

    if (!isValidDay(date)) {
        return res.status(400).json({ message: "Sana noto‘g‘ri (YYYY-MM-DD bo‘lishi kerak)." });
    }

    res.json(await getStats(date));
}));

// ---------- CSV (Excel'da ochiladi) ----------
function csvCell(value) {
    let s = String(value ?? "");
    // Excel formulasi sifatida ishlab ketmasligi uchun (=, +, -, @ bilan boshlansa)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/export?date=2026-10-30
app.get("/api/export", requireAdmin, handle(async (req, res) => {
    const date = req.query.date || todayTashkent();

    if (!isValidDay(date)) {
        return res.status(400).json({ message: "Sana noto‘g‘ri (YYYY-MM-DD bo‘lishi kerak)." });
    }

    const { rows } = await queryDocuments({ day: date, limit: 20000, offset: 0 });
    rows.reverse(); // eng eskisi birinchi

    const lines = [["Sana", "Vaqt", "Xodim", "Telegram ID", "Manzil", "Tanlangan", "Rasmlar soni"]];

    for (const d of rows) {
        const time = new Date(d.createdAt).toLocaleTimeString("ru-RU", {
            timeZone: "Asia/Tashkent",
            hour: "2-digit",
            minute: "2-digit",
        });

        lines.push([
            date,
            time,
            d.username || String(d.telegramId ?? ""),
            d.telegramId ?? "",
            d.address ?? "",
            (d.selected || []).join(", "),
            d.photoCount,
        ]);
    }

    const csv = "\uFEFF" + lines.map((r) => r.map(csvCell).join(";")).join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="arizalar-${date}.csv"`);
    res.send(csv);
}));

// SERVER
app.listen(PORT, "127.0.0.1", () => {
    console.log(
        `Admin API: http://127.0.0.1:${PORT}`
    );
});
