const Anthropic = require('@anthropic-ai/sdk')
const OpenAI = require('openai')

const TOOLS_SCHEMA = {
    generate_file: {
        description: 'Generate and save a specification file for the current stage. Call this when you have collected all answers and are ready to produce the document.',
        parameters: {
            type: 'object',
            properties: {
                filename: { type: 'string', description: 'Filename including extension, e.g. PROBLEM_STATEMENT.md' },
                content: { type: 'string', description: 'Full markdown content of the file' },
            },
            required: ['filename', 'content'],
        },
    },
    complete_stage: {
        description: 'Signal that the current stage is complete. Always call this AFTER generate_file.',
        parameters: { type: 'object', properties: {}, required: [] },
    },
}

// ─────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────
class AnthropicClient {
    constructor(apiKey, model) {
        this.client = new Anthropic.default({ apiKey })
        this.model = model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'
    }

    get tools() {
        return Object.entries(TOOLS_SCHEMA).map(([name, def]) => ({
            name,
            description: def.description,
            input_schema: def.parameters,
        }))
    }

    _mapHistory(messages) {
        return messages.map(m => {
            if (m.role === 'tool') {
                return {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || 'OK' }]
                }
            }
            if (m.role === 'assistant' && m.tool_calls?.length) {
                const content = []
                if (m.content) content.push({ type: 'text', text: m.content })
                m.tool_calls.forEach(tc => {
                    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
                })
                return { role: 'assistant', content }
            }
            return { role: m.role, content: m.content || '' }
        })
    }

    async *stream(messages, systemPrompt) {
        let continueLoop = true
        let currentMessages = this._mapHistory(messages)

        while (continueLoop) {
            continueLoop = false

            const stream = this.client.messages.stream({
                model: this.model,
                max_tokens: 4096,
                system: systemPrompt,
                messages: currentMessages,
                tools: this.tools,
            })

            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    yield { type: 'text', content: event.delta.text }
                }
            }

            const finalMsg = await stream.finalMessage()

            if (finalMsg.stop_reason === 'tool_use') {
                const assistantContent = finalMsg.content
                const toolCalls = assistantContent
                    .filter(b => b.type === 'tool_use')
                    .map(b => ({ id: b.id, name: b.name, input: b.input }))
                
                const assistantHistoryMsg = { 
                    role: 'assistant', 
                    content: assistantContent.find(b => b.type === 'text')?.text || '', 
                    tool_calls: toolCalls 
                }
                
                yield { type: 'history_update', message: assistantHistoryMsg }
                currentMessages = [...currentMessages, { role: 'assistant', content: assistantContent }]

                for (const tc of toolCalls) {
                    yield { type: 'tool_call', name: tc.name, input: tc.input }
                    const toolResMsg = { role: 'tool', tool_call_id: tc.id, content: 'OK', tool_name: tc.name }
                    yield { type: 'history_update', message: toolResMsg }
                    
                    currentMessages.push({
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: tc.id, content: 'OK' }]
                    })
                }
                continueLoop = true
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
// OpenAI / General OpenAI-compatible (Groq, Grok)
// ─────────────────────────────────────────────────────────
class OpenAIClient {
    constructor(apiKey, { baseURL, model } = {}) {
        this.client = new OpenAI.default({ apiKey, ...(baseURL ? { baseURL } : {}) })
        this.model = model || process.env.OPENAI_MODEL || 'gpt-4o'
    }

    get tools() {
        return Object.entries(TOOLS_SCHEMA).map(([name, def]) => ({
            type: 'function',
            function: { name, description: def.description, parameters: def.parameters },
        }))
    }

    _mapHistory(messages) {
        return messages.map(m => {
            const msg = { role: m.role, content: m.content || null }
            if (m.tool_calls) {
                msg.tool_calls = m.tool_calls.map(tc => ({
                    id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) }
                }))
            }
            if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
            if (m.tool_name) msg.name = m.tool_name
            return msg
        })
    }

    async *stream(messages, systemPrompt) {
        let continueLoop = true
        let currentMessages = [{ role: 'system', content: systemPrompt }, ...this._mapHistory(messages)]

        while (continueLoop) {
            continueLoop = false

            const stream = await this.client.chat.completions.create({
                model: this.model,
                messages: currentMessages,
                tools: this.tools,
                tool_choice: 'auto',
                stream: true,
            })

            let textBuffer = ''
            let toolCallsBuf = {}

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta

                if (delta?.content) {
                    textBuffer += delta.content
                    yield { type: 'text', content: delta.content }
                }

                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (!toolCallsBuf[tc.index]) {
                            toolCallsBuf[tc.index] = { id: tc.id, name: tc.function?.name || '', args: '' }
                        }
                        if (tc.function?.name) toolCallsBuf[tc.index].name = tc.function.name
                        if (tc.function?.arguments) toolCallsBuf[tc.index].args += tc.function.arguments
                    }
                }
            }

            const toolCalls = Object.values(toolCallsBuf)
            if (toolCalls.length) {
                const assistantHistoryMsg = {
                    role: 'assistant',
                    content: textBuffer || null,
                    tool_calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: JSON.parse(tc.args || '{}') }))
                }
                
                yield { type: 'history_update', message: assistantHistoryMsg }
                
                const assistantApiMsg = {
                    role: 'assistant',
                    content: textBuffer || null,
                    tool_calls: toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: { name: tc.name, arguments: tc.args },
                    })),
                }
                currentMessages = [...currentMessages, assistantApiMsg]

                for (const tc of toolCalls) {
                    let input = {}
                    try { input = JSON.parse(tc.args) } catch (_) { }
                    yield { type: 'tool_call', name: tc.name, input }
                    
                    const toolResMsg = { role: 'tool', tool_call_id: tc.id, content: 'OK', tool_name: tc.name }
                    yield { type: 'history_update', message: toolResMsg }
                    currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'OK', name: tc.name })
                }
                continueLoop = true
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────
class GeminiClient {
    constructor(apiKey, model) {
        const { GoogleGenerativeAI } = require('@google/generative-ai')
        this.genAI = new GoogleGenerativeAI(apiKey)
        this.modelName = model || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    }

    get tools() {
        return [{
            functionDeclarations: Object.entries(TOOLS_SCHEMA).map(([name, def]) => ({
                name,
                description: def.description,
                parameters: def.parameters,
            })),
        }]
    }

    _mapHistory(messages) {
        return messages.map(m => {
            const parts = []
            if (m.content) parts.push({ text: m.content })
            
            if (m.role === 'tool') {
                return { 
                    role: 'function', 
                    parts: [{ functionResponse: { name: m.tool_name || 'unknown', response: { content: m.content || 'OK' } } }] 
                }
            }
            
            if (m.role === 'assistant' && m.tool_calls) {
                m.tool_calls.forEach(tc => {
                    const callPart = { functionCall: { name: tc.name, args: tc.input } }
                    if (tc.thought_signature) {
                        callPart.thoughtSignature = tc.thought_signature
                    }
                    parts.push(callPart)
                })
            }

            return {
                role: m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'function' : 'user',
                parts
            }
        }).filter(m => m.parts.length > 0)
    }

    async *stream(messages, systemPrompt) {
        let currentHistory = this._mapHistory(messages)
        
        const model = this.genAI.getGenerativeModel({
            model: this.modelName,
            systemInstruction: systemPrompt,
            tools: this.tools,
        })

        if (currentHistory.length === 0) return

        const history = currentHistory.slice(0, -1)
        const lastMsg = currentHistory[currentHistory.length - 1]
        
        const chat = model.startChat({ history })
        let nextParts = lastMsg.parts

        while (true) {
            const result = await chat.sendMessageStream(nextParts)

            let textBuffer = ''
            let toolCalls = []

            for await (const chunk of result.stream) {
                const text = chunk.text?.()
                if (text) {
                    textBuffer += text
                    yield { type: 'text', content: text }
                }

                const candidate = chunk.candidates?.[0]
                if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.functionCall) {
                            toolCalls.push({
                                name: part.functionCall.name,
                                args: part.functionCall.args,
                                thought_signature: part.thoughtSignature || candidate.thoughtSignature
                            })
                        }
                    }
                }
            }

            if (toolCalls.length) {
                const assistantHistoryMsg = {
                    role: 'assistant',
                    content: textBuffer || null,
                    tool_calls: toolCalls.map(tc => ({ 
                        id: 'gen-' + Date.now(), 
                        name: tc.name, 
                        input: tc.args,
                        thought_signature: tc.thought_signature 
                    }))
                }
                yield { type: 'history_update', message: assistantHistoryMsg }
                
                const toolResponses = []
                for (const call of toolCalls) {
                    yield { type: 'tool_call', name: call.name, input: call.args }
                    
                    const toolResId = 'gen-' + Date.now()
                    const toolResMsg = { role: 'tool', tool_call_id: toolResId, content: 'OK', tool_name: call.name }
                    yield { type: 'history_update', message: toolResMsg }
                    
                    toolResponses.push({ 
                        functionResponse: { name: call.name, response: { content: 'OK' } } 
                    })
                }
                
                nextParts = toolResponses
            } else {
                break
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
// Factory with fallback to .env API keys
// ─────────────────────────────────────────────────────────
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
const GROK_BASE_URL = 'https://api.x.ai/v1'

const MODEL_DEFAULTS = {
    anthropic: 'claude-3-5-sonnet-20241022',
    openai: 'gpt-4o',
    gemini: 'gemini-2.0-flash',
    groq: 'llama-3.3-70b-versatile',
    grok: 'grok-2-latest',
}

function createAIClient(provider, apiKey) {
    const provUpper = provider.toUpperCase()
    const model = process.env[`${provUpper}_MODEL`] || MODEL_DEFAULTS[provider]
    
    // Fallback: If no apiKey provided in current session, use .env default key
    const finalApiKey = apiKey || process.env[`${provUpper}_API_KEY`]
    
    console.log(`[AI] Client initialized: ${provider} (${model})`)

    switch (provider) {
        case 'openai': return new OpenAIClient(finalApiKey, { model })
        case 'gemini': return new GeminiClient(finalApiKey, model)
        case 'groq': return new OpenAIClient(finalApiKey, { baseURL: GROQ_BASE_URL, model })
        case 'grok': return new OpenAIClient(finalApiKey, { baseURL: GROK_BASE_URL, model })
        case 'anthropic':
        default: return new AnthropicClient(finalApiKey, model)
    }
}

module.exports = { createAIClient, MODEL_DEFAULTS }