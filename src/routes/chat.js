const express = require('express')
const router = express.Router()
const sessionManager = require('../blueprint/sessionManager')
const { buildSystemPrompt } = require('../ai/systemPrompt')
const { createAIClient } = require('../ai/client')

// POST /api/session — create new session
router.post('/session', (req, res) => {
  const session = sessionManager.create()
  res.json({ sessionId: session.id })
})

// GET /api/session/:id — get session state
router.get('/session/:id', (req, res) => {
  const session = sessionManager.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  res.json({
    stage: session.stage,
    language: session.language,
    fileCount: Object.keys(session.files).length,
    files: Object.keys(session.files),
  })
})

// POST /api/chat/:sessionId — send message, stream response via SSE
router.post('/:sessionId', async (req, res) => {

  const { sessionId } = req.params
  const { message } = req.body

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message is required' })
  }

  const session = sessionManager.get(sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  try {
    // Detect language from first message (stage 0)
    if (session.stage === 0 && !session.language) {
      const detected = detectLanguage(message)
      if (detected) sessionManager.setLanguage(sessionId, detected)
    }

    // Persist user message
    sessionManager.addMessage(sessionId, 'user', message)

    // Rebuild session after mutations
    const freshSession = sessionManager.get(sessionId)
    const systemPrompt = buildSystemPrompt(freshSession.stage, freshSession.language)

    // Convert stored messages to provider format
    const messages = freshSession.messages.map(m => ({
      role: m.role,
      content: m.content,
    }))

    const aiClient = createAIClient()
    let assistantText = ''
    let stageAdvanced = false
    let generatedFile = null

    for await (const event of aiClient.stream(messages, systemPrompt)) {
      if (event.type === 'text') {
        assistantText += event.content
        send({ type: 'text', content: event.content })
      }

      if (event.type === 'tool_call') {
        if (event.name === 'generate_file') {
          const { filename, content } = event.input
          sessionManager.addFile(sessionId, filename, content)
          generatedFile = filename
          send({ type: 'file_generated', filename })
        }

        if (event.name === 'complete_stage') {
          const nextStage = sessionManager.advanceStage(sessionId)
          stageAdvanced = true
          send({
            type: 'stage_complete',
            completedStage: freshSession.stage,
            nextStage,
            totalStages: sessionManager.TOTAL_STAGES,
          })
          // Force break the stream to reset context for the next turn
          break
        }

      }
    }

    // Persist assistant response
    if (assistantText) {
      sessionManager.addMessage(sessionId, 'assistant', assistantText)
    }

    send({ type: 'done', stageAdvanced, generatedFile })
    res.end()

  } catch (err) {
    console.error('Chat error:', err)
    send({ type: 'error', message: 'An error occurred. Please try again.' })
    res.end()
  }
})

// Simple language detection from first message
function detectLanguage(text) {
  const spanishWords = /\b(hola|quiero|tengo|para|como|que|una|con|por|esto|eso|buenas|gracias|necesito|hacer|crear)\b/i
  const portugueseWords = /\b(olá|ola|quero|tenho|para|como|que|uma|com|por|isso|isso|bom|obrigado|preciso|fazer|criar)\b/i
  const frenchWords = /\b(bonjour|salut|je|tu|nous|vous|pour|avec|comment|merci|besoin|faire|créer)\b/i

  if (spanishWords.test(text)) return 'Spanish'
  if (portugueseWords.test(text)) return 'Portuguese'
  if (frenchWords.test(text)) return 'French'
  return 'English'
}

module.exports = router
