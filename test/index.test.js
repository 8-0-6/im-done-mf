import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ─── Set port before module load ──────────────────────────────────────────────
vi.hoisted(() => {
  process.env.IMDONE_PORT = '51292'
})

// ─── Mock node-pty (CJS require — must use __mocks__ approach or inline) ─────
vi.mock('node-pty', () => ({
  default: { spawn: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() })) },
  spawn: vi.fn(() => ({ on: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() })),
}))

// ─── Import module once ───────────────────────────────────────────────────────
const {
  randomFrom, enqueue, speak, syncHooks, loadPhrases, startServer,
  listenAndInject,
  _queue, _lastEventTime, _setSpawnFn, _resetProcessing, _setPtyChild,
} = await import('../src/index.js')

// ─── Shared mock spawn factory ────────────────────────────────────────────────
function makeSayProc(hang = false) {
  const proc = { kill: vi.fn(), on: vi.fn() }
  proc.on.mockImplementation((event, cb) => {
    if (event === 'exit' && !hang) setImmediate(() => cb(0))
  })
  return proc
}

function post(port, raw) {
  if (typeof raw !== 'string') raw = JSON.stringify(raw)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: '/event', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
      },
      (res) => {
        let out = ''
        res.on('data', d => (out += d))
        res.on('end', () => resolve({ status: res.statusCode, body: out }))
      }
    )
    req.on('error', reject)
    req.write(raw)
    req.end()
  })
}

// Reset shared queue state
function resetQueue() {
  _queue.length = 0
  Object.keys(_lastEventTime).forEach(k => delete _lastEventTime[k])
}

// ─── randomFrom ───────────────────────────────────────────────────────────────

describe('randomFrom', () => {
  it('returns an element from the array', () => {
    expect(['a', 'b', 'c']).toContain(randomFrom(['a', 'b', 'c']))
  })

  it('returns the only element from a 1-element array', () => {
    expect(randomFrom(['only'])).toBe('only')
  })
})

// ─── Queue logic ──────────────────────────────────────────────────────────────

describe('enqueue', () => {
  let mockSpawn

  beforeEach(() => {
    mockSpawn = vi.fn()
    mockSpawn.mockReturnValue(makeSayProc(true /* hang — keeps queue intact */))
    _setSpawnFn(mockSpawn)
    _resetProcessing()
    resetQueue()
  })

  it('Notification has higher priority than Stop', () => {
    enqueue({ hook_event_name: 'Stop' })
    enqueue({ hook_event_name: 'Notification' })
    // Stop was shifted to processQueue; Notification is next in queue
    expect(_queue[0].hook_event_name).toBe('Notification')
  })

  it('deduplicates — later same-type event replaces earlier one in queue', () => {
    enqueue({ hook_event_name: 'Stop', id: 1 }) // shifts to processing
    _lastEventTime['Stop'] = 0
    enqueue({ hook_event_name: 'Stop', id: 2 }) // enters queue
    _lastEventTime['Stop'] = 0
    enqueue({ hook_event_name: 'Stop', id: 3 }) // dedupes id:2 → id:3
    expect(_queue.length).toBe(1)
    expect(_queue[0].id).toBe(3)
  })

  it('debounce — rapid second event within 500ms is dropped', () => {
    enqueue({ hook_event_name: 'Stop', id: 1 }) // shifts to processing, sets debounce
    enqueue({ hook_event_name: 'Stop', id: 2 }) // <500ms → dropped
    expect(_queue.length).toBe(0) // first shifted, second dropped
  })

  it('queue cap — drops oldest when QUEUE_MAX (5) exceeded', () => {
    for (let i = 0; i < 5; i++) _queue.push({ hook_event_name: 'Notification', id: i })
    _lastEventTime['Stop'] = 0
    enqueue({ hook_event_name: 'Stop', id: 99 })
    expect(_queue.length).toBeLessThanOrEqual(5)
  })
})

// ─── speak ────────────────────────────────────────────────────────────────────

describe('speak', () => {
  let mockSpawn

  beforeEach(() => {
    mockSpawn = vi.fn()
    _setSpawnFn(mockSpawn)
  })

  it('calls say with -v and a phrase for Stop', async () => {
    mockSpawn.mockReturnValue(makeSayProc())
    await speak('Stop')
    expect(mockSpawn).toHaveBeenCalledWith('say', expect.arrayContaining(['-v']), expect.any(Object))
  })

  it('falls back to Stop phrases for unknown event names', async () => {
    mockSpawn.mockReturnValue(makeSayProc())
    await expect(speak('UnknownEvent')).resolves.toBeUndefined()
    expect(mockSpawn).toHaveBeenCalled()
  })

  it('kills the previous say process when a new speak starts', async () => {
    const proc1 = makeSayProc(true /* hang */)
    const proc2 = makeSayProc()
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)

    const p1 = speak('Stop') // starts proc1, hangs
    await speak('Stop')      // kills proc1, starts proc2, resolves

    expect(proc1.kill).toHaveBeenCalled()
    p1.catch(() => {}) // proc1 never exits — suppress unhandled rejection
  })
})

// ─── HTTP server ──────────────────────────────────────────────────────────────

describe('HTTP server', () => {
  const PORT = 51292
  let server

  beforeAll(() => {
    server = startServer()
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(() => {
    _setSpawnFn(vi.fn().mockReturnValue(makeSayProc()))
    resetQueue()
  })

  it('returns HTTP 200 with JSON {} for Stop event', async () => {
    const res = await post(PORT, { hook_event_name: 'Stop' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({})
  })

  it('returns HTTP 200 for Notification event', async () => {
    const res = await post(PORT, { hook_event_name: 'Notification' })
    expect(res.status).toBe(200)
  })

  it('returns HTTP 200 for unknown event type without crashing', async () => {
    const res = await post(PORT, { hook_event_name: 'PreToolUse' })
    expect(res.status).toBe(200)
  })

  it('returns HTTP 200 for malformed JSON without crashing', async () => {
    const res = await post(PORT, 'not json')
    expect(res.status).toBe(200)
  })
})

// ─── syncHooks ────────────────────────────────────────────────────────────────

describe('syncHooks', () => {
  let tmpDir, origCwd
  const settingsPath = () => path.join(tmpDir, '.claude', 'settings.json')
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imdone-hooks-'))
    origCwd = process.cwd
    process.cwd = () => tmpDir
  })

  afterEach(() => {
    process.cwd = origCwd
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .claude/settings.json with Stop and Notification hook entries', () => {
    syncHooks()
    const settings = readSettings()
    expect(settings.hooks.Stop).toBeDefined()
    expect(settings.hooks.Notification).toBeDefined()
    expect(settings.hooks.Stop[0].hooks[0].url).toMatch(/:\d+\/event$/)
  })

  it('preserves existing keys when merging', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify({ model: 'claude-opus-4-6' }))
    syncHooks()
    const settings = readSettings()
    expect(settings.model).toBe('claude-opus-4-6')
    expect(settings.hooks.Stop).toBeDefined()
  })

  it('creates the .claude/ directory if it does not exist', () => {
    syncHooks()
    expect(fs.existsSync(settingsPath())).toBe(true)
  })
})

// ─── loadPhrases ──────────────────────────────────────────────────────────────

describe('loadPhrases', () => {
  it('does not throw when called with an existing valid phrases.json', () => {
    expect(() => loadPhrases()).not.toThrow()
  })
})

// ─── listenAndInject ─────────────────────────────────────────────────────────

describe('listenAndInject', () => {
  let mockWrite

  beforeEach(() => {
    mockWrite = vi.fn()
    _setPtyChild({ write: mockWrite })
  })

  afterEach(() => {
    _setPtyChild(null)
  })

  it('injects transcript + \\r into ptyChild when imdone-listen exits 0 with output', async () => {
    const fakeProc = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
    fakeProc.stdout.on.mockImplementation((event, cb) => {
      if (event === 'data') setImmediate(() => cb('ship it'))
    })
    fakeProc.on.mockImplementation((event, cb) => {
      if (event === 'exit') setImmediate(() => cb(0))
    })
    _setSpawnFn(vi.fn().mockReturnValue(fakeProc))

    await listenAndInject()

    expect(mockWrite).toHaveBeenCalledWith('ship it\r')
  })

  it('does not inject when imdone-listen exits 1 (no speech)', async () => {
    const fakeProc = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
    fakeProc.on.mockImplementation((event, cb) => {
      if (event === 'exit') setImmediate(() => cb(1))
    })
    _setSpawnFn(vi.fn().mockReturnValue(fakeProc))

    await listenAndInject()

    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('does nothing when ptyChild is null', async () => {
    _setPtyChild(null)
    _setSpawnFn(vi.fn())
    await expect(listenAndInject()).resolves.toBeUndefined()
  })
})
