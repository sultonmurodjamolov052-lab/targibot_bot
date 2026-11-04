const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '../../data');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'bot.sqlite'));

// Bir nechta o'qish va yozish amallarini xavfsizroq boshqarish
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ==================== TABLES ====================
db.exec(`
    CREATE TABLE IF NOT EXISTS Document (
        id TEXT PRIMARY KEY,
        telegramId TEXT,
        username TEXT,
        selected TEXT NOT NULL DEFAULT '[]',
        address TEXT,
        photoCount INTEGER NOT NULL DEFAULT 0,
        photoFileIds TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS Photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documentId TEXT NOT NULL,
        photoIndex INTEGER NOT NULL,
        photoData BLOB NOT NULL,
        photoMime TEXT NOT NULL DEFAULT 'image/jpeg',
        createdAt TEXT NOT NULL,
        FOREIGN KEY (documentId)
            REFERENCES Document(id) ON DELETE CASCADE,
        UNIQUE(documentId, photoIndex)
    );

    CREATE INDEX IF NOT EXISTS idx_document_telegram_created
    ON Document(telegramId, createdAt);
`);

// ==================== HELPERS ====================
function parseDocument(row) {
    if (!row) return null;

    return {
        ...row,
        telegramId: row.telegramId == null
            ? null
            : Number(row.telegramId),
        selected: JSON.parse(row.selected || '[]'),
        photoFileIds: JSON.parse(row.photoFileIds || '[]'),
        photoCount: row.photoCount || 0,
    };
}

function normalizeData(data) {
    const result = { ...data };

    if (result.telegramId != null) {
        result.telegramId = String(result.telegramId);
    }

    if (Array.isArray(result.selected)) {
        result.selected = JSON.stringify(result.selected);
    }

    if (Array.isArray(result.photoFileIds)) {
        result.photoFileIds = JSON.stringify(result.photoFileIds);
    }

    return result;
}

const allowedFields = new Set([
    'telegramId',
    'username',
    'selected',
    'address',
    'photoCount',
    'photoFileIds',
]);

function insertPhoto(documentId, base64, index) {
    db.prepare(`
        INSERT INTO Photos
        (documentId, photoIndex, photoData, photoMime, createdAt)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        documentId,
        index,
        Buffer.from(base64, 'base64'),
        'image/jpeg',
        new Date().toISOString()
    );
}

function getStartOfTodayTashkent() {
    const now = new Date();
    const tashkent = new Date(now.getTime() + 5 * 60 * 60 * 1000);

    tashkent.setUTCHours(0, 0, 0, 0);

    return new Date(
        tashkent.getTime() - 5 * 60 * 60 * 1000
    ).toISOString();
}

// ==================== CREATE WITH PHOTOS ====================
const createWithPhotosTransaction = db.transaction(
    (data, photosBase64) => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO Document (
                id, telegramId, username, selected, address,
                photoCount, photoFileIds, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            data.telegramId == null ? null : String(data.telegramId),
            data.username ?? null,
            JSON.stringify(data.selected || []),
            data.address ?? null,
            photosBase64.length,
            JSON.stringify(data.photoFileIds || []),
            now
        );

        photosBase64.forEach((photo, index) => {
            insertPhoto(id, photo, index);
        });

        return id;
    }
);

async function createDocumentWithPhotos(data, photosBase64 = []) {
    return createWithPhotosTransaction(data, photosBase64);
}

// ==================== CREATE ====================
const createTransaction = db.transaction((items) => {
    const ids = [];

    const insert = db.prepare(`
        INSERT INTO Document (
            id, telegramId, username, selected, address,
            photoCount, photoFileIds, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const data = normalizeData(item);

        insert.run(
            id,
            data.telegramId ?? null,
            data.username ?? null,
            data.selected ?? '[]',
            data.address ?? null,
            data.photoCount ?? 0,
            data.photoFileIds ?? '[]',
            now
        );

        ids.push(id);
    }

    return ids;
});

async function createDocument(data) {
    return createTransaction(Array.isArray(data) ? data : [data]);
}

// ==================== READ ONE ====================
async function getDocument(id) {
    const row = db.prepare(
        'SELECT * FROM Document WHERE id = ?'
    ).get(id);

    return parseDocument(row);
}

// ==================== READ PHOTOS ====================
async function getDocumentPhotos(id) {
    const rows = db.prepare(`
        SELECT photoData
        FROM Photos
        WHERE documentId = ?
        ORDER BY photoIndex ASC
    `).all(id);

    return rows.map((row) => row.photoData.toString('base64'));
}

// ==================== READ ALL ====================
async function getAllDocuments() {
    const rows = db.prepare(`
        SELECT * FROM Document ORDER BY createdAt DESC
    `).all();

    return rows.map(parseDocument);
}

// ==================== READ TODAY BY USER ====================
async function getTodayDocumentsByUser(telegramId) {
    const start = getStartOfTodayTashkent();

    const rows = db.prepare(`
        SELECT id, telegramId, selected, address,
               photoCount, photoFileIds, createdAt, updatedAt
        FROM Document
        WHERE telegramId = ? AND createdAt >= ?
        ORDER BY createdAt ASC
    `).all(String(telegramId), start);

    return rows.map(parseDocument);
}

// ==================== UPDATE ====================
async function updateDocument(id, newData) {
    const data = normalizeData(newData);

    const fields = Object.keys(data).filter(
        (key) => allowedFields.has(key)
    );

    if (fields.length === 0) return false;

    const assignments = fields.map((field) => `${field} = ?`);
    assignments.push('updatedAt = ?');

    const values = fields.map((field) => data[field]);
    values.push(new Date().toISOString(), id);

    const result = db.prepare(`
        UPDATE Document
        SET ${assignments.join(', ')}
        WHERE id = ?
    `).run(...values);

    return result.changes > 0;
}

// ==================== UPDATE WITH PHOTOS ====================
const updateWithPhotosTransaction = db.transaction(
    (id, newData, photosBase64) => {
        const data = normalizeData(newData);

        const exists = db.prepare(
            'SELECT id FROM Document WHERE id = ?'
        ).get(id);

        if (!exists) return false;

        const fields = Object.keys(data).filter(
            (key) => allowedFields.has(key) && key !== 'photoCount'
        );

        const assignments = fields.map((field) => `${field} = ?`);
        const values = fields.map((field) => data[field]);

        assignments.push('photoCount = ?', 'updatedAt = ?');
        values.push(photosBase64.length, new Date().toISOString(), id);

        db.prepare(`
            UPDATE Document
            SET ${assignments.join(', ')}
            WHERE id = ?
        `).run(...values);

        db.prepare(
            'DELETE FROM Photos WHERE documentId = ?'
        ).run(id);

        photosBase64.forEach((photo, index) => {
            insertPhoto(id, photo, index);
        });

        return true;
    }
);

async function updateDocumentWithPhotos(
    id,
    newData,
    photosBase64 = []
) {
    return updateWithPhotosTransaction(id, newData, photosBase64);
}

// ==================== DELETE ====================
async function deleteDocument(id) {
    // Photos jadvali FOREIGN KEY orqali birga o'chadi
    const result = db.prepare(
        'DELETE FROM Document WHERE id = ?'
    ).run(id);

    return result.changes > 0;
}
// ==================== ADMIN: FILTR, SAHIFALASH, STATISTIKA ====================
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // Toshkent: UTC+5

// "YYYY-MM-DD" (Toshkent kuni) -> [boshlanishi, tugashi) ISO ko'rinishida
function dayRangeTashkent(day) {
    const start = new Date(`${day}T00:00:00.000Z`).getTime() - TZ_OFFSET_MS;
    return [
        new Date(start).toISOString(),
        new Date(start + 24 * 60 * 60 * 1000).toISOString(),
    ];
}

function shiftDay(day, delta) {
    const d = new Date(`${day}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}

// Rasmlarsiz (yengil) ro'yxat: kun, xodim va matn bo'yicha qidirish + sahifalash
async function queryDocuments({ day, telegramId, q, limit = 20, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (day) {
        const [start, end] = dayRangeTashkent(day);
        where.push('createdAt >= ? AND createdAt < ?');
        params.push(start, end);
    }

    if (telegramId) {
        where.push('telegramId = ?');
        params.push(String(telegramId));
    }

    if (q) {
        where.push("(address LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')");
        const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
        params.push(like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db
        .prepare(`SELECT COUNT(*) AS c FROM Document ${whereSql}`)
        .get(...params).c;

    const rows = db
        .prepare(`
            SELECT id, telegramId, username, selected, address,
                   photoCount, createdAt, updatedAt
            FROM Document
            ${whereSql}
            ORDER BY createdAt DESC
            LIMIT ? OFFSET ?
        `)
        .all(...params, limit, offset);

    return { total, rows: rows.map(parseDocument) };
}

// Dashboard: bir kunlik jami, xodimlar bo'yicha va oxirgi 7 kun
async function getStats(day) {
    const [start, end] = dayRangeTashkent(day);

    const totals = db
        .prepare(`
            SELECT COUNT(*) AS houses, COALESCE(SUM(photoCount), 0) AS photos
            FROM Document
            WHERE createdAt >= ? AND createdAt < ?
        `)
        .get(start, end);

    const perUser = db
        .prepare(`
            SELECT telegramId, MAX(username) AS username,
                   COUNT(*) AS houses, COALESCE(SUM(photoCount), 0) AS photos
            FROM Document
            WHERE createdAt >= ? AND createdAt < ?
            GROUP BY telegramId
            ORDER BY houses DESC
        `)
        .all(start, end);

    const [weekStart] = dayRangeTashkent(shiftDay(day, -6));
    const weekRows = db
        .prepare(`
            SELECT date(createdAt, '+5 hours') AS day,
                   COUNT(*) AS houses, COALESCE(SUM(photoCount), 0) AS photos
            FROM Document
            WHERE createdAt >= ? AND createdAt < ?
            GROUP BY day
        `)
        .all(weekStart, end);

    const byDay = new Map(weekRows.map((r) => [r.day, r]));
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = shiftDay(day, -i);
        const r = byDay.get(d);
        last7.push({ day: d, houses: r?.houses || 0, photos: r?.photos || 0 });
    }

    return {
        date: day,
        totals: { houses: totals.houses, photos: totals.photos, workers: perUser.length },
        perUser,
        last7,
    };
}

// ==================== EXPORTS ====================
module.exports = {
    createDocument,
    createDocumentWithPhotos,
    getDocument,
    getDocumentPhotos,
    getAllDocuments,
    getTodayDocumentsByUser,
    updateDocument,
    updateDocumentWithPhotos,
    deleteDocument,
    queryDocuments,
    getStats,
};
