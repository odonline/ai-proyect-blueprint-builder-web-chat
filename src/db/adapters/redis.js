const Redis = require('ioredis')

function buildConfig() {
    if (process.env.REDIS_URL) return process.env.REDIS_URL

    const config = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB || '0'),
        lazyConnect: true,
    }

    if (process.env.REDIS_TLS === 'true') config.tls = {}

    return config
}

class RedisAdapter {
    constructor() {
        this.client = new Redis(buildConfig())
        this.client.on('connect', () => console.log('✅ Redis connected'))
        this.client.on('error', (err) => console.error('❌ Redis error:', err.message))
        this.client.on('reconnecting', () => console.log('🔄 Redis reconnecting…'))
    }

    async get(key) {
        return this.client.get(key)  // string | null
    }

    async set(key, value, ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds)
    }

    async ttl(key) {
        return this.client.ttl(key)  // seconds remaining, -2 if missing
    }

    async del(key) {
        return this.client.del(key)
    }
}

module.exports = RedisAdapter