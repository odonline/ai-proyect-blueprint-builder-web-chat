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

    let session = await sessionManager.get(sessionId)
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

        let iteration = 0
        let shouldContinue = true
        let generatedFilesThisTurn = new Set()
        let stageAdvancedInThisTurn = false
        let totalAssistantText = ''

        while (shouldContinue && iteration < 5) {
            shouldContinue = false
            iteration++

            const freshSession = await sessionManager.get(sessionId)
            const systemPrompt = buildSystemPrompt(freshSession.stage, freshSession.language, freshSession.files)
            const aiClient = createAIClient(freshSession.provider, freshSession.apiKey)

            const messages = freshSession.messages.map(m => ({
                role: m.role,
                content: m.content,
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
                tool_name: m.tool_name
            }))

            // 🚀 BRIDGE: If we advanced a stage in a previous iteration, tell the AI to start the new stage now.
            if (iteration > 1 && stageAdvancedInThisTurn) {
                messages.push({ 
                    role: 'user', 
                    content: `[SYSTEM] Stage successfully advanced. You are now in Stage ${freshSession.stage} (${freshSession.language}). Please proceed with the instructions for this stage immediately.` 
                })
            }

            let assistantText = ''
            let loopStageAdvanced = false
            let assistantMessageSaved = false

            console.log(`[AI][Turn ${iteration}] Starting stream for ${sessionId} (Stage: ${freshSession.stage})`)

            for await (const event of aiClient.stream(messages, systemPrompt)) {
                if (event.type === 'text') {
                    assistantText += event.content
                    totalAssistantText += event.content
                    send({ type: 'text', content: event.content })
                }

                if (event.type === 'tool_call') {
                    if (event.name === 'generate_file') {
                        const { filename, content } = event.input
                        console.log(`[AI] Tool: Generating file "${filename}" for ${sessionId}`)
                        await sessionManager.addFile(sessionId, filename, content)
                        
                        if (!generatedFilesThisTurn.has(filename)) {
                            generatedFilesThisTurn.add(filename)
                            send({ type: 'file_generated', filename })
                        }
                    }

                    if (event.name === 'complete_stage') {
                        const nextStage = await sessionManager.advanceStage(sessionId)
                        loopStageAdvanced = true
                        stageAdvancedInThisTurn = true
                        console.log(`[AI] Tool: Stage complete (${freshSession.stage} -> ${nextStage}) for ${sessionId}`)
                        send({
                            type: 'stage_complete',
                            completedStage: freshSession.stage,
                            nextStage,
                            totalStages: sessionManager.TOTAL_STAGES,
                        })
                        break // Break inner loop to reload instructions for next turn
                    }
                }

                if (event.type === 'history_update') {
                    if (event.message.role === 'assistant') assistantMessageSaved = true
                    await sessionManager.addMessage(sessionId, event.message.role, event.message.content, {
                        tool_calls: event.message.tool_calls,
                        tool_call_id: event.message.tool_call_id,
                        tool_name: event.message.tool_name
                    })
                }
            }

            if (assistantText && !assistantMessageSaved) {
                await sessionManager.addMessage(sessionId, 'assistant', assistantText)
            }

            if (loopStageAdvanced && freshSession.stage <= sessionManager.TOTAL_STAGES) {
                shouldContinue = true
                console.log(`[AI] Auto-transitioning to turn ${iteration + 1} for ${sessionId}`)
                
                // Add visual separator if previous turn had actual conversational text
                if (assistantText.trim()) {
                   send({ type: 'text', content: '\n\n---\n\n' }) 
                }
            }
        }

        console.log(`[AI] Response cycles finished for ${sessionId}`)
        send({ 
            type: 'done', 
            stageAdvanced: stageAdvancedInThisTurn, 
            generatedFile: Array.from(generatedFilesThisTurn).pop() || null 
        })
        res.end()

    } catch (err) {
        console.error(`[Error] Chat issue for ${sessionId}:`, err)
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