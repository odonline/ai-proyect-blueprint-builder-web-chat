const db = require('../db')
const { encrypt, decrypt } = require('../utils/crypto')
const { v4: uuidv4 } = require('uuid')

const TOTAL_STAGES = 18

const TTL_SESSION = parseInt(process.env.REDIS_TTL_SESSION || '604800')  // 7 days
const TTL_FILES = parseInt(process.env.REDIS_TTL_FILES || '172800')  // 2 days

const sessionKey = (id) => `session:${id}`
const filesKey = (id) => `session:${id}:files`

// ─────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────
async function create({ provider, apiKey }) {
    const id = uuidv4()
    const now = Date.now()

    const meta = {
        id,
        stage: 0,
        language: null,
        messages: [],
        provider,
        apiKeyEncrypted: encrypt(apiKey),
        createdAt: now,
        updatedAt: now,
    }

    await db.set(sessionKey(id), JSON.stringify(meta), TTL_SESSION)
    return { id, stage: meta.stage, provider }
}

// ─────────────────────────────────────────────────────────
// Get — never returns the raw API key, only decrypts internally
// ─────────────────────────────────────────────────────────
async function get(id) {
    const raw = await db.get(sessionKey(id))
    if (!raw) return null

    const session = JSON.parse(raw)

    const filesRaw = await db.get(filesKey(id))
    session.files = filesRaw ? JSON.parse(filesRaw) : {}

    // Expose decrypted key only inside the process — never serialized back
    session.apiKey = decrypt(session.apiKeyEncrypted)
    delete session.apiKeyEncrypted

    return session
}

// ─────────────────────────────────────────────────────────
// Add message
// ─────────────────────────────────────────────────────────
async function addMessage(id, role, content) {
    const session = await _getSessionOnly(id)
    if (!session) throw new Error(`Session ${id} not found`)

    session.messages.push({ role, content })
    session.updatedAt = Date.now()

    await db.set(sessionKey(id), JSON.stringify(session), TTL_SESSION)
}

// ─────────────────────────────────────────────────────────
// Set language
// ─────────────────────────────────────────────────────────
async function setLanguage(id, language) {
    const session = await _getSessionOnly(id)
    if (!session) throw new Error(`Session ${id} not found`)

    session.language = language
    session.updatedAt = Date.now()

    await db.set(sessionKey(id), JSON.stringify(session), TTL_SESSION)
}

// ─────────────────────────────────────────────────────────
// Add file
// ─────────────────────────────────────────────────────────
async function addFile(id, filename, content) {
    const filesRaw = await db.get(filesKey(id))
    const files = filesRaw ? JSON.parse(filesRaw) : {}

    files[filename] = content

    await db.set(filesKey(id), JSON.stringify(files), TTL_FILES)
}

// ─────────────────────────────────────────────────────────
// Advance stage
// ─────────────────────────────────────────────────────────
async function advanceStage(id) {
    const session = await _getSessionOnly(id)
    if (!session) throw new Error(`Session ${id} not found`)

    const next = Math.min(session.stage + 1, TOTAL_STAGES + 1)
    session.stage = next
    session.updatedAt = Date.now()

    await db.set(sessionKey(id), JSON.stringify(session), TTL_SESSION)
    return next
}

// ─────────────────────────────────────────────────────────
// TTL info
// ─────────────────────────────────────────────────────────
async function getTTLInfo(id) {
    const [sessionTTL, filesTTL] = await Promise.all([
        db.ttl(sessionKey(id)),
        db.ttl(filesKey(id)),
    ])
    return { sessionExpiresIn: sessionTTL, filesExpiresIn: filesTTL }
}

// ─────────────────────────────────────────────────────────
// Internal — raw session without file fetch or key decrypt
// ─────────────────────────────────────────────────────────
async function _getSessionOnly(id) {
    const raw = await db.get(sessionKey(id))
    return raw ? JSON.parse(raw) : null
}

module.exports = {
    create,
    get,
    addMessage,
    setLanguage,
    addFile,
    advanceStage,
    getTTLInfo,
    TOTAL_STAGES,
}