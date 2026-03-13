/* ─── State ─────────────────────────────────────────────── */
let sessionId = null
let currentStage = 0
const TOTAL_STAGES = 18

/* ─── DOM refs ──────────────────────────────────────────── */
const landing = document.getElementById('landing')
const chatScreen = document.getElementById('chat-screen')
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('message-input')
const sendBtn = document.getElementById('send-btn')
const stageBadge = document.getElementById('stage-badge')
const progressBar = document.getElementById('progress-bar')
const downloadBtn = document.getElementById('download-btn')
const headerStatus = document.getElementById('header-status')
const startBtn = document.getElementById('start-btn')

/* ─── Init ──────────────────────────────────────────────── */
startBtn.addEventListener('click', startSession)

async function startSession() {
    startBtn.disabled = true
    startBtn.textContent = 'Starting…'

    try {
        const res = await fetch('/api/chat/session', { method: 'POST' })
        const data = await res.json()
        sessionId = data.sessionId

        landing.classList.add('hidden')
        chatScreen.classList.remove('hidden')

        enableInput()
        updateProgress(0)


        // Trigger initial greeting from AI
        await sendMessage('__init__')
    } catch (err) {
        startBtn.disabled = false
        startBtn.textContent = 'Start Building →'
        alert('Failed to connect. Check the server is running.')
    }
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

// Auto-resize textarea
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

    // Show user message (skip for init trigger)
    if (text !== '__init__') {
        appendMessage('out', text)
    }

    // Show typing indicator
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
            buffer = lines.pop() // keep incomplete line

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
                    updateProgress(currentStage)
                    showToast(`✅ Stage ${event.completedStage + 1} complete`)
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
    // Re-render formatted content before the time element
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
function updateProgress(stage) {
    const displayStage = Math.min(stage, TOTAL_STAGES)
    const pct = (displayStage / TOTAL_STAGES) * 100
    progressBar.style.width = pct + '%'

    if (stage === 0) {
        stageBadge.style.display = 'none'
    } else if (stage > TOTAL_STAGES) {
        stageBadge.style.display = 'inline-block'
        stageBadge.textContent = `Completed ✓`
        stageBadge.style.background = 'rgba(0, 168, 132, 0.3)'
    } else {
        stageBadge.style.display = 'inline-block'
        stageBadge.textContent = `Stage ${stage} / ${TOTAL_STAGES}`
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

// Minimal safe markdown-ish renderer (bold, italic, code, newlines)
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