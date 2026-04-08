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

const DEBOUNCE_MS = 500
const TTS_TIMEOUT_MS = 30_000
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
  const voice = phrases.voice || 'Ava'

  return new Promise((resolve) => {
    if (ttsProc) { ttsProc.kill(); ttsProc = null }

    const proc = spawnFn('say', ['-v', voice, phrase], { stdio: 'ignore' })
    ttsProc = proc

    const timeout = setTimeout(() => {
      console.error('\n[imdone] say timed out — skipping')
      proc.kill()
      ttsProc = null
      resolve()
    }, TTS_TIMEOUT_MS)

    proc.on('exit', () => {
      clearTimeout(timeout)
      ttsProc = null
      resolve()
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
    try { await speak(event.hook_event_name) }
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

  ptyProcess.on('data', (data) => process.stdout.write(data))

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (data) => ptyProcess.write(data))
  }

  const onResize = () => ptyProcess.resize(process.stdout.columns, process.stdout.rows)
  process.stdout.on('resize', onResize)

  ptyProcess.on('exit', (code) => {
    process.stdout.off('resize', onResize)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.exit(code ?? 0)
  })

  return ptyProcess
}

// --- Main ---
function main() {
  runStartupChecks()
  startServer()
  spawnClaude(process.argv.slice(2))
}

if (require.main === module) {
  main()
} else {
  // Test-only seams — not part of the public API
  function _setSpawnFn(fn) { spawnFn = fn }
  function _resetProcessing() { isProcessing = false }

  module.exports = {
    enqueue, processQueue, speak, syncHooks, loadPhrases, startServer, randomFrom,
    _queue: queue, _lastEventTime: lastEventTime, _setSpawnFn, _resetProcessing,
  }
}
