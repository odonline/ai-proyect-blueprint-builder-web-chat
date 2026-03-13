const Anthropic = require('@anthropic-ai/sdk')
const OpenAI = require('openai')

// Tool definitions (provider-agnostic schema)
const TOOLS_SCHEMA = {
  generate_file: {
    description: 'Generate and save a specification file for the current stage. Call this when you have collected all answers and are ready to produce the document.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The filename including extension, e.g. PROBLEM_STATEMENT.md',
        },
        content: {
          type: 'string',
          description: 'The full markdown content of the file',
        },
      },
      required: ['filename', 'content'],
    },
  },
  complete_stage: {
    description: 'Signal that the current stage is complete and all questions have been answered. Always call this AFTER generate_file.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
}

// ─────────────────────────────────────────────────────────
// Anthropic client
// ─────────────────────────────────────────────────────────
class AnthropicClient {
  constructor() {
    this.client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
    this.model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
  }

  get tools() {
    return Object.entries(TOOLS_SCHEMA).map(([name, def]) => ({
      name,
      description: def.description,
      input_schema: def.parameters,
    }))
  }

  // Stream response — yields { type: 'text'|'tool_call', ... }
  async *stream(messages, systemPrompt) {
    let continueLoop = true
    let currentMessages = [...messages]

    while (continueLoop) {
      continueLoop = false
      const toolCalls = []
      let textBuffer = ''

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: currentMessages,
        tools: this.tools,
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            textBuffer += event.delta.text
            yield { type: 'text', content: event.delta.text }
          }
        }

        if (event.type === 'message_delta' && event.delta.stop_reason === 'tool_use') {
          // tool use blocks come in the final message
        }
      }

      // Get the full final message for tool processing
      const finalMsg = await stream.finalMessage()

      if (finalMsg.stop_reason === 'tool_use') {
        const assistantContent = finalMsg.content
        currentMessages = [...currentMessages, { role: 'assistant', content: assistantContent }]

        const toolResults = []
        for (const block of assistantContent) {
          if (block.type === 'tool_use') {
            toolCalls.push({ name: block.name, input: block.input, id: block.id })
            yield { type: 'tool_call', name: block.name, input: block.input }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'OK',
            })
          }
        }

        currentMessages = [...currentMessages, { role: 'user', content: toolResults }]
        continueLoop = true
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// OpenAI client
// ─────────────────────────────────────────────────────────
class OpenAIClient {
  constructor() {
    this.client = new OpenAI.default({ apiKey: process.env.OPENAI_API_KEY })
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
      let toolCallsBuffer = {}

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (delta?.content) {
          textBuffer += delta.content
          yield { type: 'text', content: delta.content }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallsBuffer[tc.index]) {
              toolCallsBuffer[tc.index] = { id: tc.id, name: tc.function?.name || '', args: '' }
            }
            if (tc.function?.name) toolCallsBuffer[tc.index].name = tc.function.name
            if (tc.function?.arguments) toolCallsBuffer[tc.index].args += tc.function.arguments
          }
        }

        if (chunk.choices[0]?.finish_reason === 'tool_calls') {
          const toolCalls = Object.values(toolCallsBuffer)
          const assistantMsg = {
            role: 'assistant',
            content: textBuffer || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
            })),
          }
          currentMessages = [...currentMessages, assistantMsg]

          const toolResults = []
          for (const tc of toolCalls) {
            let input = {}
            try { input = JSON.parse(tc.args) } catch (_) { }
            yield { type: 'tool_call', name: tc.name, input }
            toolResults.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: 'OK',
            })
          }

          currentMessages = [...currentMessages, ...toolResults]
          continueLoop = true
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// Gemini client
// ─────────────────────────────────────────────────────────
class GeminiClient {
  constructor() {
    const { GoogleGenerativeAI } = require('@google/generative-ai')
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    this.modelName = process.env.GEMINI_MODEL || 'gemini-3.0-flash'
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

  // Convert OpenAI-style messages to Gemini format
  _convertMessages(messages, systemPrompt) {
    const history = []
    for (const msg of messages) {
      if (msg.role === 'user') {
        history.push({ role: 'user', parts: [{ text: msg.content }] })
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          history.push({ role: 'model', parts: [{ text: msg.content }] })
        }
      }
    }
    return history
  }

  async *stream(messages, systemPrompt) {
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemPrompt,
      tools: this.tools,
    })

    const history = this._convertMessages(messages.slice(0, -1), systemPrompt)
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
// Factory
// ─────────────────────────────────────────────────────────
function createAIClient() {
  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase()
  switch (provider) {
    case 'openai': return new OpenAIClient()
    case 'gemini': return new GeminiClient()
    default: return new AnthropicClient()
  }
}

module.exports = { createAIClient }
