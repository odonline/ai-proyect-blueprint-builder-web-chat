const db = require('../db/adapters/sqlite3.js')
const { v4: uuidv4 } = require('uuid')

const TOTAL_STAGES = 18

function create() {
  const id = uuidv4()
  const now = Date.now()
  db.prepare(`
    INSERT INTO sessions (id, stage, language, messages, files, created_at, updated_at)
    VALUES (?, 0, NULL, '[]', '{}', ?, ?)
  `).run(id, now, now)
  return get(id)
}

function get(id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  if (!row) return null
  return {
    id: row.id,
    stage: row.stage,
    language: row.language,
    messages: JSON.parse(row.messages),
    files: JSON.parse(row.files),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function addMessage(id, role, content) {
  const session = get(id)
  if (!session) throw new Error(`Session ${id} not found`)
  const messages = [...session.messages, { role, content }]
  db.prepare(`
    UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(messages), Date.now(), id)
}

function setLanguage(id, language) {
  db.prepare(`UPDATE sessions SET language = ?, updated_at = ? WHERE id = ?`)
    .run(language, Date.now(), id)
}

function addFile(id, filename, content) {
  const session = get(id)
  if (!session) throw new Error(`Session ${id} not found`)
  const files = { ...session.files, [filename]: content }
  db.prepare(`UPDATE sessions SET files = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(files), Date.now(), id)
}

function advanceStage(id) {
  const session = get(id)
  if (!session) throw new Error(`Session ${id} not found`)
  const next = Math.min(session.stage + 1, TOTAL_STAGES + 1)
  db.prepare(`UPDATE sessions SET stage = ?, updated_at = ? WHERE id = ?`)
    .run(next, Date.now(), id)
  return next
}

function isComplete(id) {
  const session = get(id)
  return session && session.stage >= TOTAL_STAGES
}

module.exports = { create, get, addMessage, setLanguage, addFile, advanceStage, isComplete, TOTAL_STAGES }
