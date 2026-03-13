const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DATA_DIR = path.join(__dirname, '../../data')

class SQLiteAdapter {
    constructor() {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

        this.db = new Database(path.join(DATA_DIR, 'sessions.db'))

        this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        expires_at  INTEGER        -- unix ms, NULL = no expiry
      )
    `)

        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_expires_at ON sessions (expires_at)
      WHERE expires_at IS NOT NULL
    `)

        this._startGC()
        console.log('✅ SQLite connected (sessions.db)')
    }

    async get(key) {
        const row = this.db
            .prepare('SELECT value, expires_at FROM sessions WHERE id = ?')
            .get(key)

        if (!row) return null

        if (row.expires_at !== null && Date.now() > row.expires_at) {
            this.db.prepare('DELETE FROM sessions WHERE id = ?').run(key)
            return null
        }

        return row.value
    }

    async set(key, value, ttlSeconds) {
        const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null

        this.db.prepare(`
      INSERT INTO sessions (id, value, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    `).run(key, value, expiresAt)
    }

    async ttl(key) {
        const row = this.db
            .prepare('SELECT expires_at FROM sessions WHERE id = ?')
            .get(key)

        if (!row) return -2                      // key missing (Redis convention)
        if (row.expires_at === null) return -1   // no expiry

        const remaining = Math.round((row.expires_at - Date.now()) / 1000)
        return remaining > 0 ? remaining : -2
    }

    async del(key) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(key)
    }

    // ─── Garbage collector ──────────────────────────────────
    _gcExpired() {
        this.db
            .prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?')
            .run(Date.now())
    }

    _startGC() {
        const INTERVAL_MS = 60 * 60 * 1000  // every hour
        setInterval(() => {
            try {
                const result = this.db
                    .prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?')
                    .run(Date.now())
                if (result.changes > 0) {
                    console.log(`🧹 SQLite GC: removed ${result.changes} expired entries`)
                }
            } catch (err) {
                console.error('SQLite GC error:', err.message)
            }
        }, INTERVAL_MS).unref()
    }
}

module.exports = SQLiteAdapter