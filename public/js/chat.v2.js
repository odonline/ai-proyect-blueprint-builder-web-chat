/* ─── State ─────────────────────────────────────────────── */
let sessionId = null
let currentStage = 0
const TOTAL_STAGES = 18

/* ─── DOM refs ──────────────────────────────────────────── */
const landing = document.getElementById('landing')
const setupScreen = document.getElementById('setup-screen')
const chatScreen = document.getElementById('chat-screen')
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('message-input')
const sendBtn = document.getElementById('send-btn')
const stageBadge = document.getElementById('stage-badge')
const progressBar = document.getElementById('progress-bar')
const downloadBtn = document.getElementById('download-btn')
const headerStatus = document.getElementById('header-status')
const providerTag = document.getElementById('provider-tag')
const startBtn = document.getElementById('start-btn')
const setupBackBtn = document.getElementById('setup-back-btn')
const connectBtn = document.getElementById('connect-btn')
const apiKeyInput = document.getElementById('api-key-input')
const toggleKeyBtn = document.getElementById('toggle-key-btn')
const setupError = document.getElementById('setup-error')
const freeTip = document.getElementById('free-tip')
const tipText = document.getElementById('tip-text')

/* ─── Provider tips ─────────────────────────────────────── */
const FREE_TIPS = {
    gemini: 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com</a> — no credit card required.',
    groq: 'Get a free key at <a href="https://console.groq.com" target="_blank">console.groq.com</a> — no credit card required.',
}

/* ─── Landing → Setup ───────────────────────────────────── */
startBtn.addEventListener('click', () => {
    landing.classList.add('hidden')
    setupScreen.classList.remove('hidden')
})

setupBackBtn.addEventListener('click', () => {
    setupScreen.classList.add('hidden')
    landing.classList.remove('hidden')
    hideSetupError()
})

/* ─── Provider selection ────────────────────────────────── */
let selectedProvider = 'anthropic'

document.querySelectorAll('.provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.provider-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        selectedProvider = btn.dataset.provider

        if (FREE_TIPS[selectedProvider]) {
            tipText.innerHTML = FREE_TIPS[selectedProvider]
            freeTip.style.display = 'block'
        } else {
            freeTip.style.display = 'none'
        }

        apiKeyInput.placeholder = `Paste your ${btn.querySelector('.provider-name').textContent} API key`
    })
})

/* ─── Show/hide key ─────────────────────────────────────── */
toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password'
    apiKeyInput.type = isPassword ? 'text' : 'password'
    toggleKeyBtn.textContent = isPassword ? '🙈' : '👁'
})

/* ─── Connect → Start session ───────────────────────────── */
connectBtn.addEventListener('click', startSession)
apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startSession()
})

async function startSession() {
    const apiKey = apiKeyInput.value.trim()

    if (!apiKey) {
        showSetupError('Please enter your API key.')
        return
    }

    connectBtn.disabled = true
    connectBtn.textContent = 'Connecting…'
    hideSetupError()

    try {
        const res = await fetch('/api/chat/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: selectedProvider, apiKey }),
        })

        const data = await res.json()

        if (!res.ok) {
            showSetupError(data.error || 'Failed to connect.')
            connectBtn.disabled = false
            connectBtn.textContent = 'Connect & Start →'
            return
        }

        sessionId = data.sessionId

        // Clear key from memory as soon as we have the sessionId
        apiKeyInput.value = ''

        setupScreen.classList.add('hidden')
        chatScreen.classList.remove('hidden')
        providerTag.textContent = selectedProvider.toUpperCase()

        enableInput()
        updateProgress(0)

        await sendMessage('__init__')

    } catch (err) {
        showSetupError('Connection failed. Is the server running?')
        connectBtn.disabled = false
        connectBtn.textContent = 'Connect & Start →'
    }
}

function showSetupError(msg) {
    setupError.textContent = msg
    setupError.classList.remove('hidden')
}

function hideSetupError() {
    setupError.classList.add('hidden')
}

/* ─── Input handling ────────────────────────────────────── */
function enableInput() {
    inputEl.disabled = false
    sendBtn.disabled = false
    inputEl.focus()
}

function disableInput() {
    inputEl.disabled = true
    sendBtn.disabled = true
}

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
    }
})

sendBtn.addEventListener('click', handleSend)

inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
})

function handleSend() {
    const text = inputEl.value.trim()
    if (!text || inputEl.disabled) return
    inputEl.value = ''
    inputEl.style.height = 'auto'
    sendMessage(text)
}

/* ─── Core send / SSE stream ─────────────────────────────── */
async function sendMessage(text) {
    disableInput()
    setStatus('typing…')

    if (text !== '__init__') appendMessage('out', text)

    const typingId = showTyping()

    try {
        const res = await fetch(`/api/chat/${sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let botBubble = null

        while (true) {
            const { value, done } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                let event
                try { event = JSON.parse(line.slice(6)) } catch { continue }

                if (event.type === 'text') {
                    removeTyping(typingId)
                    if (!botBubble) botBubble = createStreamBubble()
                    appendToStreamBubble(botBubble, event.content)
                }

                if (event.type === 'file_generated') {
                    appendSystemMsg(`📄 Generated: ${event.filename}`)
                }

                if (event.type === 'stage_complete') {
                    currentStage = event.nextStage
                    updateProgress(event.completedStage)
                    showToast(`✅ Stage ${event.completedStage} complete`)
                }

                if (event.type === 'done') {
                    if (botBubble) finalizeStreamBubble(botBubble)

                    if (currentStage > TOTAL_STAGES) {
                        downloadBtn.classList.remove('hidden')
                        setStatus('complete')
                    } else {
                        setStatus('online')
                    }
                    enableInput()
                }

                if (event.type === 'error') {
                    removeTyping(typingId)
                    appendSystemMsg(`❌ ${event.message}`)
                    setStatus('online')
                    enableInput()
                }
            }
        }
    } catch (err) {
        console.error(err)
        removeTyping(typingId)
        appendSystemMsg('❌ Connection error. Please try again.')
        setStatus('online')
        enableInput()
    }
}

/* ─── Message rendering ─────────────────────────────────── */
function appendMessage(direction, text) {
    const msg = document.createElement('div')
    msg.className = `msg ${direction}`

    const bubble = document.createElement('div')
    bubble.className = 'msg-bubble'
    bubble.innerHTML = formatText(text)

    const time = document.createElement('span')
    time.className = 'msg-time'
    time.textContent = now()

    bubble.appendChild(time)
    msg.appendChild(bubble)
    messagesEl.appendChild(msg)
    scrollToBottom()
    return msg
}

function createStreamBubble() {
    const msg = document.createElement('div')
    msg.className = 'msg in'

    const bubble = document.createElement('div')
    bubble.className = 'msg-bubble'
    bubble.setAttribute('data-raw', '')

    const time = document.createElement('span')
    time.className = 'msg-time'
    time.textContent = now()

    bubble.appendChild(time)
    msg.appendChild(bubble)
    messagesEl.appendChild(msg)
    scrollToBottom()
    return { msg, bubble, time }
}

function appendToStreamBubble({ bubble, time }, text) {
    const raw = (bubble.getAttribute('data-raw') || '') + text
    bubble.setAttribute('data-raw', raw)
    const formatted = document.createElement('span')
    formatted.innerHTML = formatText(raw)
    bubble.innerHTML = ''
    bubble.appendChild(formatted)
    bubble.appendChild(time)
    scrollToBottom()
}

function finalizeStreamBubble({ bubble, time }) {
    const raw = bubble.getAttribute('data-raw') || ''
    bubble.innerHTML = formatText(raw)
    bubble.appendChild(time)
}

function appendSystemMsg(text) {
    const wrap = document.createElement('div')
    wrap.className = 'msg-system'
    const inner = document.createElement('div')
    inner.className = 'msg-system-inner'
    inner.textContent = text
    wrap.appendChild(inner)
    messagesEl.appendChild(wrap)
    scrollToBottom()
}

function showTyping() {
    const id = 'typing-' + Date.now()
    const msg = document.createElement('div')
    msg.className = 'msg in'
    msg.id = id

    const bubble = document.createElement('div')
    bubble.className = 'msg-bubble typing-bubble'
    bubble.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>'

    msg.appendChild(bubble)
    messagesEl.appendChild(msg)
    scrollToBottom()
    return id
}

function removeTyping(id) {
    const el = document.getElementById(id)
    if (el) el.remove()
}

/* ─── Progress & status ─────────────────────────────────── */
function updateProgress(completedStage) {
    const displayStage = Math.min(completedStage, TOTAL_STAGES)
    const pct = (displayStage / TOTAL_STAGES) * 100
    progressBar.style.width = pct + '%'

    if (completedStage === 0) {
        stageBadge.textContent = `Stage 0 / ${TOTAL_STAGES}`
    } else if (completedStage > TOTAL_STAGES) {
        stageBadge.textContent = `Completed ✓`
        stageBadge.style.background = 'rgba(0, 168, 132, 0.3)'
    } else {
        stageBadge.textContent = `Stage ${completedStage} / ${TOTAL_STAGES}`
    }
}

function setStatus(text) {
    headerStatus.textContent = text
}

function showToast(text) {
    const existing = document.querySelector('.toast')
    if (existing) existing.remove()
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.textContent = text
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
}

/* ─── Download ──────────────────────────────────────────── */
downloadBtn.addEventListener('click', () => {
    window.location.href = `/api/download/${sessionId}`
})

/* ─── Helpers ───────────────────────────────────────────── */
function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
}

function now() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>')
}