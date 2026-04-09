#!/usr/bin/env node
'use strict'

const http = require('http')
const pty = require('node-pty')
const { execFileSync, spawn: _spawn } = require('child_process')
let spawnFn = _spawn
const fs = require('fs')
const os = require('os')
const path = require('path')

// --- Config ---
const PORT = parseInt(process.env.IMDONE_PORT || '51234', 10)
const IMDONE_DIR = path.join(os.homedir(), '.imdone')
const PHRASES_PATH = path.join(IMDONE_DIR, 'phrases.json')
const DEFAULT_PHRASES = require('./phrases.json')
const LISTEN_BINARY = path.join(__dirname, '..', 'bin', 'imdone-listen')

const DEBOUNCE_MS = 500
const TTS_TIMEOUT_MS = 30_000
const STT_TIMEOUT_MS = 35_000
const QUEUE_MAX = 5
const PRIORITY = { Notification: 0, Stop: 1 }
const LOG = '[imdone]'
const AUDIO_SESSION_TEARDOWN_MS = 200
const ELEVENLABS_API_HOST = 'api.elevenlabs.io'
const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel
const AUDIO_DIR = path.join(os.homedir(), '.imdone', 'audio')
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aiff', '.m4a'])
const DEFAULT_SAY_VOICE = 'Rocko (English (US))'
const ABBREVIATION_REPLACEMENTS = [
  [/\bmf\b/gi, 'motherfucker'],
  [/\brn\b/gi, 'right now'],
  [/\bfr\b/gi, 'for real'],
]

function normalizeHookType(event) {
  const raw = event && (
    event.hook_event_name ||
    event.hookEventName ||
    event.event_name ||
    event.eventName ||
    event.type
  )
  if (typeof raw !== 'string') return null

  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (s === 'stop' || s.includes('stop')) return 'Stop'
  if (s === 'notification' || s.includes('notification')) return 'Notification'
  return null
}

// --- Helpers ---
function die(msg) {
  console.error(`\nimdone: ${msg}\n`)
  process.exit(1)
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function readJSON(filePath, label, { allowMissing = false } = {}) {
  let raw
  try { raw = fs.readFileSync(filePath, 'utf8') }
  catch (e) {
    if (allowMissing && e.code === 'ENOENT') return null
    die(`Could not read ${label}: ${e.message}`)
  }
  try { return JSON.parse(raw) }
  catch { die(`${label} is not valid JSON. Fix it and re-run imdone.\nPath: ${filePath}`) }
}

function normalizePhraseText(value, dirty = { changed: false }) {
  if (typeof value === 'string') {
    let s = value
    for (const [pattern, replacement] of ABBREVIATION_REPLACEMENTS) {
      s = s.replace(pattern, replacement)
    }
    if (s !== value) dirty.changed = true
    return s
  }
  if (Array.isArray(value)) return value.map(v => normalizePhraseText(v, dirty))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizePhraseText(v, dirty)])
    )
  }
  return value
}

// --- Startup checks ---
function runStartupChecks() {
  try { execFileSync('which', ['claude'], { stdio: 'ignore' }) }
  catch { die('`claude` not found on PATH. Install Claude Code first.') }

  try { execFileSync('which', ['say'], { stdio: 'ignore' }) }
  catch { die('macOS `say` command not found. macOS 12+ required.') }

  loadPhrases()
  syncHooks()
}

// --- Phrases ---
let phrases = DEFAULT_PHRASES

function loadPhrases() {
  fs.mkdirSync(IMDONE_DIR, { recursive: true })

  try {
    fs.writeFileSync(PHRASES_PATH, JSON.stringify(DEFAULT_PHRASES, null, 2), { flag: 'wx' })
    return  // wrote defaults — file was missing
  } catch (e) {
    if (e.code !== 'EEXIST') die(`Could not create phrases.json: ${e.message}`)
  }

  const loaded = readJSON(PHRASES_PATH, 'phrases.json')
  const dirty = { changed: false }
  phrases = normalizePhraseText(loaded, dirty)

  // Keep user's phrases file in sync so TTS always says full words.
  if (dirty.changed) fs.writeFileSync(PHRASES_PATH, JSON.stringify(phrases, null, 2))
}

// --- Hook sync ---
function syncHooks() {
  const settingsPath = path.join(process.cwd(), '.claude', 'settings.json')
  const hookEntry = [{ matcher: '', hooks: [{ type: 'http', url: `http://localhost:${PORT}/event` }] }]
  const settings = readJSON(settingsPath, '.claude/settings.json', { allowMissing: true }) || {}

  settings.hooks = Object.assign({}, settings.hooks, {
    Stop:         hookEntry,
    Notification: hookEntry,
  })

  // Atomic write: temp → rename avoids partial reads by Claude Code
  const tmp = settingsPath + '.tmp.' + process.pid
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
  fs.renameSync(tmp, settingsPath)
}

// --- TTS ---
let fetchFn = fetch
let ttsProc = null
let ttsAbort = null

function killTTS() {
  if (ttsAbort) { ttsAbort.abort(); ttsAbort = null }
  if (ttsProc) { ttsProc.kill(); ttsProc = null }
}

function findLocalAudioFile(eventName) {
  const dir = path.join(AUDIO_DIR, eventName.toLowerCase())
  let files
  try { files = fs.readdirSync(dir) }
  catch { return null }
  const audioFiles = files.filter(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
  if (!audioFiles.length) return null
  return path.join(dir, randomFrom(audioFiles))
}

function speak(eventName) {
  const pool = phrases[eventName] || phrases['Stop']
  const phrase = randomFrom(Array.isArray(pool) ? pool : [pool])

  return new Promise((resolve) => {
    killTTS()
    let done = false

    function finish() {
      if (done) return
      done = true
      clearTimeout(timeout)
      ttsProc = null
      ttsAbort = null
      resolve()
    }

    const timeout = setTimeout(() => {
      console.error(`\n${LOG} TTS timed out — skipping`)
      killTTS()
      finish()
    }, TTS_TIMEOUT_MS)

    // Tier 1: local audio file
    const localFile = findLocalAudioFile(eventName)
    if (localFile) {
      const player = spawnFn('afplay', [localFile], { stdio: 'ignore' })
      ttsProc = player
      player.on('exit', finish)
      return
    }

    // Tier 2: ElevenLabs (if API key set)
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (apiKey) {
      const voiceId = process.env.ELEVENLABS_VOICE_ID || ELEVENLABS_DEFAULT_VOICE_ID
      const controller = new AbortController()
      ttsAbort = controller

      fetchFn(`https://${ELEVENLABS_API_HOST}/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: phrase,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: controller.signal,
      }).then(async (res) => {
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          console.error(`${LOG} ElevenLabs error ${res.status}: ${errText.slice(0, 200)}`)
          finish()
          return
        }
        const buf = await res.arrayBuffer()
        ttsAbort = null
        const tmpFile = path.join(os.tmpdir(), `imdone-${Date.now()}.mp3`)
        fs.writeFileSync(tmpFile, Buffer.from(buf))
        const player = spawnFn('afplay', [tmpFile], { stdio: 'ignore' })
        ttsProc = player
        player.on('exit', () => { fs.unlink(tmpFile, () => {}); finish() })
      }).catch((e) => {
        if (e.name !== 'AbortError') console.error(`${LOG} ElevenLabs request failed: ${e.message}`)
        finish()
      })
      return
    }

    // Tier 3: macOS say (always available fallback)
    const voice = phrases.voice || DEFAULT_SAY_VOICE
    const proc = spawnFn('say', ['-v', voice, phrase], { stdio: 'ignore' })
    ttsProc = proc
    proc.on('exit', finish)
  })
}

// --- STT + PTY injection ---
let ptyChild = null
let sttProc = null

function cancelSTT() {
  if (sttProc) {
    sttProc.kill()
    sttProc = null
  }
}

function listenAndInject() {
  if (!ptyChild) return Promise.resolve()

  if (!fs.existsSync(LISTEN_BINARY)) {
    process.stdout.write(`\n${LOG} imdone-listen not found — voice input disabled. Run \`imdone --diagnose\`.\n`)
    return Promise.resolve()
  }

  process.stdout.write(`\n${LOG} Listening... (speak now)\n`)
  return new Promise((resolve) => {
    const proc = spawnFn(LISTEN_BINARY, [], { stdio: ['ignore', 'pipe', 'inherit'] })
    sttProc = proc
    let transcript = ''
    let done = false

    function finish(heard) {
      if (done) return
      done = true
      clearTimeout(timeout)
      sttProc = null
      if (heard) {
        process.stdout.write(`\n${LOG} I heard: ${heard}\n`)
        ptyChild.write(heard + '\r')
      } else {
        process.stdout.write(`\n${LOG} No speech detected. Continuing.\n`)
      }
      resolve()
    }

    const timeout = setTimeout(() => { proc.kill(); finish(null) }, STT_TIMEOUT_MS)

    proc.stdout.on('data', (chunk) => {
      transcript += chunk
      if (transcript.length > 10_000) transcript = transcript.slice(-5_000)
    })

    proc.on('exit', (code) => {
      const heard = transcript.trim()
      finish(code === 0 && heard ? heard : null)
    })
  })
}

// --- Event queue ---
const queue = []
const lastEventTime = {}
let isProcessing = false

function enqueue(event) {
  const type = event.hook_event_name
  const now = Date.now()

  if (lastEventTime[type] && now - lastEventTime[type] < DEBOUNCE_MS) return
  lastEventTime[type] = now

  const idx = queue.findIndex(e => e.hook_event_name === type)
  if (idx !== -1) queue.splice(idx, 1)

  const p = PRIORITY[type] ?? 99
  const insertAt = queue.findIndex(e => (PRIORITY[e.hook_event_name] ?? 99) > p)
  if (insertAt === -1) queue.push(event)
  else queue.splice(insertAt, 0, event)

  if (queue.length > QUEUE_MAX) {
    const dropped = queue.shift()
    console.error(`${LOG} queue full — dropped ${dropped.hook_event_name} event`)
  }

  cancelSTT()
  processQueue()
}

async function processQueue() {
  if (isProcessing) return
  isProcessing = true
  while (queue.length > 0) {
    const event = queue.shift()
    try {
      cancelSTT()
      await speak(event.hook_event_name)
      if (event.hook_event_name === 'Stop') {
        await new Promise(r => setTimeout(r, AUDIO_SESSION_TEARDOWN_MS))
        await listenAndInject()
      }
    }
    catch (e) { console.error(`${LOG} speak error:`, e.message) }
  }
  isProcessing = false
}

// --- HTTP server ---
function startServer() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 102_400) { req.destroy(); return }
    })
    req.on('end', () => {
      // Claude Code requires JSON response — plain text causes "JSON validation failed" in UI
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')

      let event
      try { event = JSON.parse(body) }
      catch {
        console.error(`${LOG} malformed hook POST:`, body.slice(0, 200))
        return
      }

      const type = normalizeHookType(event)
      if (!type) {
        const raw = event.hook_event_name || event.hookEventName || event.event_name || event.eventName || event.type
        console.error(`${LOG} skipping unsupported hook event: ${String(raw || 'unknown')}`)
        return
      }

      enqueue(Object.assign({}, event, { hook_event_name: type }))
    })
  })

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      die(`Port ${PORT} is already in use.\nSet IMDONE_PORT env var to use a different port.\nNote: .claude/settings.json hook URL must match the port imdone actually uses.`)
    }
    die(`HTTP server error: ${e.message}`)
  })

  server.listen(PORT, '127.0.0.1')

  return server
}

// --- PTY ---
function spawnClaude(args) {
  const ptyProcess = pty.spawn('claude', args, {
    name: 'xterm-color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env,
  })

  ptyChild = ptyProcess
  ptyProcess.on('data', (data) => process.stdout.write(data))

  const onStdinData = (data) => ptyProcess.write(data)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onStdinData)
  }

  const onResize = () => ptyProcess.resize(process.stdout.columns, process.stdout.rows)
  process.stdout.on('resize', onResize)

  ptyProcess.on('exit', (code) => {
    ptyChild = null
    process.stdout.off('resize', onResize)
    if (process.stdin.isTTY) {
      process.stdin.off('data', onStdinData)
      process.stdin.setRawMode(false)
    }
    process.exit(code ?? 0)
  })

  return ptyProcess
}

// --- Diagnose ---
async function runDiagnose() {
  const checks = []

  const check = (name, ok, fix = null) => checks.push({ name, ok, fix })

  try { execFileSync('which', ['claude'], { stdio: 'ignore' }); check('`claude` on PATH', true) }
  catch { check('`claude` on PATH', false, 'Install Claude Code first') }

  try { execFileSync('which', ['say'], { stdio: 'ignore' }); check('`say` on PATH', true) }
  catch { check('`say` on PATH', false, 'macOS 12+ required') }

  try { execFileSync('which', ['afplay'], { stdio: 'ignore' }); check('`afplay` on PATH', true) }
  catch { check('`afplay` on PATH', false, 'macOS 12+ required') }

  const stopAudio = findLocalAudioFile('Stop')
  check('local audio files (Stop)', !!stopAudio,
    `optional — drop .mp3/.wav files in ${path.join(AUDIO_DIR, 'stop')} for custom audio`)

  check('ElevenLabs API key (optional)', !!process.env.ELEVENLABS_API_KEY,
    'optional — export ELEVENLABS_API_KEY=your_key to enable ElevenLabs TTS')

  const settingsPath = path.join(process.cwd(), '.claude', 'settings.json')
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const url = s?.hooks?.Stop?.[0]?.hooks?.[0]?.url
    check('.claude/settings.json hook URL', !!(url && url.includes('/event')), 'Run `imdone` once to auto-configure')
  } catch { check('.claude/settings.json', false, 'Run `imdone` once to auto-configure') }

  try {
    const raw = fs.readFileSync(PHRASES_PATH, 'utf8')
    try { JSON.parse(raw); check('phrases.json valid', true) }
    catch { check('phrases.json', false, 'Fix JSON syntax error') }
  } catch (e) { check('phrases.json', false, e.code === 'ENOENT' ? 'Run `imdone` once to create defaults' : e.message) }

  check('imdone-listen binary', fs.existsSync(LISTEN_BINARY), 'Reinstall imdone-mf')

  const portFree = await new Promise((resolve) => {
    const srv = http.createServer()
    srv.on('error', () => resolve(false))
    srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
  check(`Port ${PORT} available`, portFree, 'Another imdone may be running')

  const pass = checks.filter(c => c.ok).length
  console.log('\nimdone --diagnose')
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  →  ${c.fix}`}`)
  console.log(`\n${pass}/${checks.length} checks passed`)
  process.exit(pass === checks.length ? 0 : 1)
}

// --- Main ---
function main() {
  const args = process.argv.slice(2)
  if (args.includes('--diagnose')) { runDiagnose(); return }

  runStartupChecks()
  startServer()
  spawnClaude(args)
}

if (require.main === module) {
  main()
} else {
  // Test-only seams — not part of the public API
  function _setSpawnFn(fn) { spawnFn = fn }
  function _setFetch(fn) { fetchFn = fn }
  function _resetProcessing() { isProcessing = false }
  function _setPtyChild(child) { ptyChild = child }

  module.exports = {
    enqueue, processQueue, speak, syncHooks, loadPhrases, startServer, randomFrom,
    listenAndInject, cancelSTT,
    _queue: queue, _lastEventTime: lastEventTime, _setSpawnFn, _setFetch, _resetProcessing, _setPtyChild,
  }
}
