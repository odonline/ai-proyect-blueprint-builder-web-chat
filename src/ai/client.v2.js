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
    constructor(apiKey) {
        this.client = new Anthropic.default({ apiKey })
        this.model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
    }

    get tools() {
        return Object.entries(TOOLS_SCHEMA).map(([name, def]) => ({
            name,
            description: def.description,
            input_schema: def.parameters,
        }))
    }

    async *stream(messages, systemPrompt) {
        let continueLoop = true
        let currentMessages = [...messages]

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
                currentMessages = [...currentMessages, { role: 'assistant', content: assistantContent }]

                const toolResults = []
                for (const block of assistantContent) {
                    if (block.type === 'tool_use') {
                        yield { type: 'tool_call', name: block.name, input: block.input }
                        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'OK' })
                    }
                }

                currentMessages = [...currentMessages, { role: 'user', content: toolResults }]
                continueLoop = true
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
// OpenAI (also works for Groq — same SDK, different baseURL)
// ─────────────────────────────────────────────────────────
class OpenAIClient {
    constructor(apiKey, { baseURL } = {}) {
        this.client = new OpenAI.default({ apiKey, ...(baseURL ? { baseURL } : {}) })
        this.model = process.env.OPENAI_MODEL || 'gpt-4.1'
    }

    get tools() {
        return Object.entries(TOOLS_SCHEMA).map(([name, def]) => ({
            type: 'function',
            function: { name, description: def.description, parameters: def.parameters },
        }))
    }

    async *stream(messages, systemPrompt) {
        let continueLoop = true
        let currentMessages = [{ role: 'system', content: systemPrompt }, ...messages]

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

                if (chunk.choices[0]?.finish_reason === 'tool_calls') {
                    const toolCalls = Object.values(toolCallsBuf)
                    const assistantMsg = {
                        role: 'assistant',
                        content: textBuffer || null,
                        tool_calls: toolCalls.map(tc => ({
                            id: tc.id, type: 'function',
                            function: { name: tc.name, arguments: tc.args },
                        })),
                    }
                    currentMessages = [...currentMessages, assistantMsg]

                    const toolResults = []
                    for (const tc of toolCalls) {
                        let input = {}
                        try { input = JSON.parse(tc.args) } catch (_) { }
                        yield { type: 'tool_call', name: tc.name, input }
                        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: 'OK' })
                    }

                    currentMessages = [...currentMessages, ...toolResults]
                    continueLoop = true
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────
class GeminiClient {
    constructor(apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai')
        this.genAI = new GoogleGenerativeAI(apiKey)
        this.modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
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

    async *stream(messages, systemPrompt) {
        const model = this.genAI.getGenerativeModel({
            model: this.modelName,
            systemInstruction: systemPrompt,
            tools: this.tools,
        })

        const history = messages.slice(0, -1).map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
        })).filter(m => m.parts[0].text)

        const lastMsg = messages[messages.length - 1]
        const chat = model.startChat({ history })
        const result = await chat.sendMessageStream(lastMsg.content)

        let toolCalls = []

        for await (const chunk of result.stream) {
            const text = chunk.text?.()
            if (text) yield { type: 'text', content: text }

            const calls = chunk.functionCalls?.()
            if (calls?.length) toolCalls = [...toolCalls, ...calls]
        }

        for (const call of toolCalls) {
            yield { type: 'tool_call', name: call.name, input: call.args }
        }
    }
}

// ─────────────────────────────────────────────────────────
// Factory — driven by session provider + apiKey
// ─────────────────────────────────────────────────────────
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

const MODEL_DEFAULTS = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4.1',
    gemini: 'gemini-2.0-flash',
    groq: 'llama-3.3-70b-versatile',
}

function createAIClient(provider, apiKey) {
    switch (provider) {
        case 'openai': return new OpenAIClient(apiKey)
        case 'gemini': return new GeminiClient(apiKey)
        case 'groq': return new OpenAIClient(apiKey, { baseURL: GROQ_BASE_URL })
        case 'anthropic':
        default: return new AnthropicClient(apiKey)
    }
}

module.exports = { createAIClient, MODEL_DEFAULTS }