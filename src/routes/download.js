const express = require('express')
const router = express.Router()
const archiver = require('archiver')
const sessionManager = require('../blueprint/sessionManager.v2')

// GET /api/download/:sessionId
router.get('/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const session = sessionManager.get(sessionId)

  if (!session) return res.status(404).json({ error: 'Session not found' })

  const files = session.files
  if (Object.keys(files).length === 0) {
    return res.status(400).json({ error: 'No files generated yet' })
  }

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="blueprint-specs-${sessionId.slice(0, 8)}.zip"`)

  const archive = archiver('zip', { zlib: { level: 9 } })
  archive.on('error', (err) => { throw err })
  archive.pipe(res)

  // Add all generated spec files
  for (const [filename, content] of Object.entries(files)) {
    archive.append(content, { name: `Specs/${filename}` })
  }

  // Add a state summary file
  const stateContent = [
    `# Blueprint Session Summary`,
    ``,
    `Session ID : ${sessionId}`,
    `Stages completed : ${session.stage} / ${sessionManager.TOTAL_STAGES}`,
    `Language : ${session.language || 'English'}`,
    `Generated : ${new Date().toISOString()}`,
    ``,
    `## Generated Files`,
    ...Object.keys(files).map(f => `- Specs/${f}`),
    ``,
    `## Next Steps`,
    `1. Open this folder in Claude Code`,
    `2. Copy your CLAUDE.md and .claude/ commands to this folder`,
    `3. Run /spec-audit to validate the specifications`,
    `4. Hand the Specs/ folder to your implementation agent`,
  ].join('\n')

  archive.append(stateContent, { name: 'SESSION_SUMMARY.md' })
  archive.finalize()
})

module.exports = router
