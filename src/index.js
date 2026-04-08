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
const PIPER_DIR = path.join(IMDONE_DIR, 'piper')
const PIPER_BINARY = path.join(PIPER_DIR, 'piper')
const PIPER_MODEL = path.join(IMDONE_DIR, 'en_US-lessac-high.onnx')

const DEBOUNCE_MS = 500
const TTS_TIMEOUT_MS = 30_000
const STT_TIMEOUT_MS = 35_000
const QUEUE_MAX = 5
const PRIORITY = { Notification: 0, Stop: 1 }

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

  phrases = readJSON(PHRASES_PATH, 'phrases.json')
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
let ttsProc = null

function speak(eventName) {
  const pool = phrases[eventName] || phrases['Stop']
  const phrase = randomFrom(Array.isArray(pool) ? pool : [pool])
  const voice = phrases.voice || 'Rocko (English (US))'
  const usePiper = fs.existsSync(PIPER_BINARY) && fs.existsSync(PIPER_MODEL)

  return new Promise((resolve) => {
    if (ttsProc) { ttsProc.kill(); ttsProc = null }

    let done = false
    let killCurrent = null

    // Proxy so preemption works regardless of which stage (piper vs afplay) is active
    ttsProc = { kill: () => { if (killCurrent) killCurrent() } }

    function finish() {
      if (done) return
      done = true
      clearTimeout(timeout)
      if (killCurrent) killCurrent()
      ttsProc = null
      resolve()
    }

    const timeout = setTimeout(() => {
      console.error('\n[imdone] tts timed out — skipping')
      finish()
    }, TTS_TIMEOUT_MS)

    if (usePiper) {
      const tmpWav = path.join(os.tmpdir(), `imdone-${process.pid}.wav`)
      const piper = spawnFn(PIPER_BINARY, ['--model', PIPER_MODEL, '--output-file', tmpWav], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, DYLD_LIBRARY_PATH: PIPER_DIR },
      })
      killCurrent = () => { piper.kill(); try { fs.unlinkSync(tmpWav) } catch {} }
      piper.stdin.write(phrase)
      piper.stdin.end()

      piper.on('exit', (code) => {
        if (done) return
        if (code !== 0) { finish(); return }
        const afplay = spawnFn('afplay', [tmpWav], { stdio: 'ignore' })
        killCurrent = () => { afplay.kill(); try { fs.unlinkSync(tmpWav) } catch {} }
        afplay.on('exit', () => { try { fs.unlinkSync(tmpWav) } catch {}; finish() })
      })
    } else {
      const proc = spawnFn('say', ['-v', voice, phrase], { stdio: 'ignore' })
      killCurrent = () => proc.kill()
      proc.on('exit', finish)
    }
  })
}

// --- STT + PTY injection ---
let ptyChild = null

function listenAndInject() {
  if (!ptyChild) return Promise.resolve()

  if (!fs.existsSync(LISTEN_BINARY)) {
    process.stdout.write('\n[imdone] imdone-listen not found — voice input disabled. Run `imdone --diagnose`.\n')
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const proc = spawnFn(LISTEN_BINARY, [], { stdio: ['ignore', 'pipe', 'inherit'] })
    let transcript = ''
    let done = false

    function finish(heard) {
      if (done) return
      done = true
      clearTimeout(timeout)
      if (heard) {
        process.stdout.write(`\n[imdone] I heard: ${heard}\n`)
        ptyChild.write(heard + '\r')
      } else {
        process.stdout.write('\n[imdone] No speech detected. Continuing.\n')
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
    console.error(`[imdone] queue full — dropped ${dropped.hook_event_name} event`)
  }

  processQueue()
}

async function processQueue() {
  if (isProcessing) return
  isProcessing = true
  while (queue.length > 0) {
    const event = queue.shift()
    try {
      await speak(event.hook_event_name)
      if (event.hook_event_name === 'Stop') await listenAndInject()
    }
    catch (e) { console.error('[imdone] speak error:', e.message) }
  }
  isProcessing = false
}

// --- HTTP server ---
function startServer() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      // Claude Code requires JSON response — plain text causes "JSON validation failed" in UI
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')

      let event
      try { event = JSON.parse(body) }
      catch {
        console.error('[imdone] malformed hook POST:', body.slice(0, 200))
        return
      }

      const type = event.hook_event_name
      if (!(type in PRIORITY)) return

      enqueue(event)
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

  try { execFileSync('which', ['say'], { stdio: 'ignore' }); check('`say` command on PATH', true) }
  catch { check('`say` command on PATH', false, 'macOS 12+ required') }

  try { execFileSync('which', ['claude'], { stdio: 'ignore' }); check('`claude` on PATH', true) }
  catch { check('`claude` on PATH', false, 'Install Claude Code first') }

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
  check('Piper TTS', fs.existsSync(PIPER_BINARY) && fs.existsSync(PIPER_MODEL), 'Run `imdone --setup-piper` for better voice quality (optional)')

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
  if (args.includes('--setup-piper')) { require('../scripts/setup-piper.js'); return }

  runStartupChecks()
  startServer()
  spawnClaude(args)
}

if (require.main === module) {
  main()
} else {
  // Test-only seams — not part of the public API
  function _setSpawnFn(fn) { spawnFn = fn }
  function _resetProcessing() { isProcessing = false }
  function _setPtyChild(child) { ptyChild = child }

  module.exports = {
    enqueue, processQueue, speak, syncHooks, loadPhrases, startServer, randomFrom,
    listenAndInject,
    _queue: queue, _lastEventTime: lastEventTime, _setSpawnFn, _resetProcessing, _setPtyChild,
  }
}
