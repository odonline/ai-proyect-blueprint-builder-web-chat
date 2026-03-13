/**
 * Storage factory — reads DB_TYPE from .env and returns the correct adapter.
 *
 * Both adapters expose the same interface:
 *   get(key)                    → string | null
 *   set(key, value, ttlSeconds) → void
 *   ttl(key)                    → seconds remaining (-2 = missing, -1 = no expiry)
 *   del(key)                    → void
 */

const DB_TYPE = (process.env.DB_TYPE || 'sqlite').toLowerCase()

let adapter

if (DB_TYPE === 'redis') {
  const RedisAdapter = require('./adapters/redis')
  adapter = new RedisAdapter()
} else if (DB_TYPE === 'sqlite') {
  const SQLiteAdapter = require('./adapters/sqlite-adapter')
  adapter = new SQLiteAdapter()
} else {
  throw new Error(`Unknown DB_TYPE "${DB_TYPE}". Valid options: sqlite | redis`)
}

module.exports = adapter