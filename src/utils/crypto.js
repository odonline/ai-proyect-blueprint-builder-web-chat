const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const TAG_LENGTH = 16

function getKey() {
    const raw = process.env.ENCRYPTION_KEY
    if (!raw) throw new Error('ENCRYPTION_KEY is not set in .env')

    // Accept a 64-char hex string (32 bytes) or derive from any string via SHA-256
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        return Buffer.from(raw, 'hex')
    }

    return crypto.createHash('sha256').update(raw).digest()
}

/**
 * Encrypt a plaintext string.
 * Returns a hex string: iv (32 chars) + authTag (32 chars) + ciphertext (n chars)
 */
function encrypt(plaintext) {
    const key = getKey()
    const iv = crypto.randomBytes(IV_LENGTH)

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return Buffer.concat([iv, tag, encrypted]).toString('hex')
}

/**
 * Decrypt a hex string produced by encrypt().
 * Returns the original plaintext string.
 */
function decrypt(hex) {
    const key = getKey()
    const data = Buffer.from(hex, 'hex')

    const iv = data.subarray(0, IV_LENGTH)
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH)

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

module.exports = { encrypt, decrypt }