const express = require('express')
const router = express.Router()
const sessionManager = require('../blueprint/sessionManager.v2')
const { buildSystemPrompt } = require('../ai/systemPrompt')
const { createAIClient } = require('../ai/client.v2')

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'gemini', 'groq']

// ─────────────────────────────────────────────────────────
// POST /api/chat/session — create session with provider + key
// ─────────────────────────────────────────────────────────
router.post('/session', async (req, res) => {
    const { provider, apiKey } = req.body

    if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
        return res.status(400).json({
            error: `Invalid provider. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
        })
    }

    if (!apiKey?.trim()) {
        return res.status(400).json({ error: 'apiKey is required' })
    }

    try {
        const session = await sessionManager.create({ provider, apiKey: apiKey.trim() })
        console.log(`[Session] Created: ${session.id} (${provider})`)
        res.json({ sessionId: session.id, provider: session.provider })
    } catch (err) {
        console.error('Create session error:', err)
        res.status(500).json({ error: 'Failed to create session' })
    }
})

// ─────────────────────────────────────────────────────────
// GET /api/chat/session/:id — session status
// ─────────────────────────────────────────────────────────
router.get('/session/:id', async (req, res) => {
    try {
        const session = await sessionManager.get(req.params.id)
        if (!session) return res.status(404).json({ error: 'Session not found' })

        const ttl = await sessionManager.getTTLInfo(req.params.id)

        res.json({
            stage: session.stage,
            language: session.language,
            provider: session.provider,
            fileCount: Object.keys(session.files).length,
            files: Object.keys(session.files),
            sessionExpiresIn: ttl.sessionExpiresIn,
            filesExpiresIn: ttl.filesExpiresIn,
        })
    } catch (err) {
        console.error('Get session error:', err)
        res.status(500).json({ error: 'Failed to get session' })
    }
})

// ─────────────────────────────────────────────────────────
// POST /api/chat/:sessionId — send message, stream via SSE
// ─────────────────────────────────────────────────────────
router.post('/:sessionId', async (req, res) => {
    const { sessionId } = req.params
    const { message } = req.body

    if (!message?.trim()) {
        return res.status(400).json({ error: 'Message is required' })
    }

    const session = await sessionManager.get(sessionId)
    if (!session) return res.status(404).json({ error: 'Session not found or expired' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

    try {
        console.log(`[Chat] Message from ${sessionId}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`)

        if (session.stage === 0 && !session.language) {
            const detected = detectLanguage(message)
            if (detected) {
                console.log(`[Chat] Language detected for ${sessionId}: ${detected}`)
                await sessionManager.setLanguage(sessionId, detected)
            }
        }

        await sessionManager.addMessage(sessionId, 'user', message)

        const freshSession = await sessionManager.get(sessionId)
        const systemPrompt = buildSystemPrompt(freshSession.stage, freshSession.language)

        const messages = freshSession.messages.map(m => ({
            role: m.role,
            content: m.content,
        }))

        // Use provider + decrypted key from session
        const aiClient = createAIClient(freshSession.provider, freshSession.apiKey)
        let assistantText = ''
        let stageAdvanced = false
        let generatedFile = null

        console.log(`[AI] Starting stream for ${sessionId} (Stage: ${freshSession.stage})`)

        for await (const event of aiClient.stream(messages, systemPrompt)) {
            console.log(`[AI] Event: ${event.type}`)
            if (event.type === 'text') {
                assistantText += event.content
                send({ type: 'text', content: event.content })
            }

            if (event.type === 'tool_call') {
                if (event.name === 'generate_file') {
                    const { filename, content } = event.input
                    console.log(`[AI] Tool: Generating file "${filename}" for ${sessionId}`)
                    await sessionManager.addFile(sessionId, filename, content)
                    generatedFile = filename
                    send({ type: 'file_generated', filename })
                }

                if (event.name === 'complete_stage') {
                    const nextStage = await sessionManager.advanceStage(sessionId)
                    stageAdvanced = true
                    console.log(`[AI] Tool: Stage complete (${freshSession.stage} -> ${nextStage}) for ${sessionId}`)
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

        if (assistantText) {
            console.log(`[AI][assistantText] Adding message for ${sessionId}`)
            await sessionManager.addMessage(sessionId, 'assistant', assistantText)
        }

        console.log(`[AI] Stream complete for ${sessionId}`)
        send({ type: 'done', stageAdvanced, generatedFile })
        res.end()

    } catch (err) {
        console.error(`[Error] Chat issue for ${sessionId}:`, err)

        // Surface auth errors to the user clearly
        const isAuthError = err.status === 401 || err.message?.includes('API key')
        send({
            type: 'error',
            message: isAuthError
                ? 'Invalid API key. Please check your credentials and start a new session.'
                : 'An error occurred. Please try again.',
        })
        res.end()
    }
})

function detectLanguage(text) {
    const spanish = /\b(hola|quiero|tengo|para|como|que|una|con|por|esto|eso|buenas|gracias|necesito|hacer|crear)\b/i
    const portuguese = /\b(olá|ola|quero|tenho|para|como|que|uma|com|por|isso|bom|obrigado|preciso|fazer|criar)\b/i
    const french = /\b(bonjour|salut|je|tu|nous|vous|pour|avec|comment|merci|besoin|faire|créer)\b/i

    if (spanish.test(text)) return 'Spanish'
    if (portuguese.test(text)) return 'Portuguese'
    if (french.test(text)) return 'French'
    return 'English'
}

module.exports = router