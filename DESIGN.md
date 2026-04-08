# Architecture Design: im done mf

Generated: 2026-04-08
Session: /plan-ceo-review + /office-hours
Status: DRAFT — reviewed 3x by adversarial AI reviewer, quality score 8/10

---

## Problem Statement

Developers who run Claude Code for long tasks have no ambient awareness of progress. They either stare at the terminal (wasteful) or miss the task completion entirely (frustrating). The product solves this with event-gated voice: silent by default, only speaks when something needs the human's attention, in the most irreverent tone possible.

## What Makes This Cool

The "whoa" moment is auditory. A developer walking back to their desk hears: "yo, your shit's done mf." That clip is the tweet. That's the entire distribution strategy for v0.

The market insight: voice INPUT tools for AI coding outnumber voice OUTPUT tools 10:1. 5+ community tools do basic TTS notifications (clarvis, claudevoice-macos, AgentVibes, etc.) — but none are products. They're hacks: TTS-only, no STT loop, no distribution, no brand.

im done mf differentiates on four things the community tools don't have:
1. **Brand** — "yo your shit's done mf" is a tweet-able moment. That clip is the distribution strategy.
2. **The full loop** — TTS + STT + clipboard injection. Community tools stop at speaking.
3. **Real distribution** — `npm install -g imdone-mf`. Clean install, works first time.
4. **Quality** — debouncing, priority queuing, failure handling. Not a shell script.

---

## Architecture Decision: HTTP Server + Claude Code HTTP Hooks

### Approaches Considered

| Approach | Description | Decision |
|----------|-------------|----------|
| A: Pure Hook Scripts | Direct hook-to-TTS, no persistent process | Rejected — no persistent process means no STT loop |
| B: PTY Wrapper for I/O interception | `imdone` wraps `claude` as PTY, parses stdout to detect events | Rejected — fragile. Parsing terminal output to detect state is a landmine. |
| C: HTTP Server + HTTP Hooks | Local server receives hook POSTs from Claude Code | **CHOSEN for event detection** |
| D: HTTP Hooks + PTY for process management | C for events, PTY only for spawning claude + stdin injection | **CHOSEN for UX** (one terminal, direct voice injection) |

### Why D (not just C)

HTTP hooks handle all event detection — Claude Code POSTs to `imdone` when something happens. That part is clean and decoupled.

PTY is used for two things that HTTP hooks can't do: (1) let `imdone` be the one command the user runs, and (2) give `imdone` a handle to Claude Code's stdin so voice transcripts can be injected directly. This is not I/O interception — `imdone` does not read or parse Claude Code's output. PTY is one-directional: `imdone` only *writes* to it when injecting voice.

`node-pty` is battle-tested (used by VS Code's terminal). Shipped as pre-compiled binaries — no user-side compilation.

### First-Run Hook Setup

On every run, `imdone` syncs the hook config in `.claude/settings.json` to match the port it's actually using. User never touches the file manually.

```javascript
// Atomic write: temp file → rename
// VERIFIED schema (spike 2026-04-08): hooks require { matcher, hooks } nesting
const port = process.env.IMDONE_PORT || 51234
const hookEntry = (url) => [{ matcher: '', hooks: [{ type: 'http', url }] }]
const settings = readOrCreate('.claude/settings.json')   // throws if invalid JSON → startup error
settings.hooks = {
  Stop:         hookEntry(`http://localhost:${port}/event`),
  Notification: hookEntry(`http://localhost:${port}/event`)
}
writeAtomic('.claude/settings.json', settings)
```

Runs on every launch (not first-run only) so IMDONE_PORT overrides always take effect.
If settings.json contains invalid JSON: print "settings.json is not valid JSON — fix it and re-run imdone. Path: [path]" and exit. Never silently overwrite.

### Architecture Diagram

```
Developer runs: imdone [task]    ← ONE command. That's it.

On first run:
  imdone auto-writes .claude/settings.json with HTTP hooks

On every run:
  1. Start HTTP server on :51234 (background thread)
  2. Spawn claude via node-pty (PTY child process)
  3. PTY stdout → developer's terminal  (pass-through, unmodified)
  4. Developer's keyboard → PTY stdin   (pass-through, unmodified)
  5. Ctrl-C, window resize forwarded to PTY child

┌─────────────────────────────────────────────────┐
│  imdone process                                  │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │ HTTP Server  │    │ PTY child: claude      │  │
│  │ :51234       │    │                        │  │
│  │              │    │ stdout ──► terminal    │  │
│  │  ┌─────────┐ │    │ stdin  ◄── keyboard   │  │
│  │  │ Worker  │ │    │        ◄── [STT inject]│  │
│  │  └────┬────┘ │    └───────────────────────┘  │
│  └───────┼──────┘                                │
│          │ (async, never blocks HTTP 200)         │
│    TTS → STT → ptyChild.write(transcript + '\n') │
└─────────────────────────────────────────────────┘

Hook fires → POST http://localhost:51234/event
  VERIFIED payload schema (spike 2026-04-08):
  Stop:        { hook_event_name, session_id, transcript_path, cwd, permission_mode,
                 stop_hook_active, last_assistant_message }
  PreToolUse:  { hook_event_name, session_id, transcript_path, cwd, permission_mode,
                 tool_name, tool_input, tool_use_id }
  PostToolUse: { hook_event_name, session_id, transcript_path, cwd, permission_mode,
                 tool_name, tool_input, tool_response, tool_use_id }

  HTTP response MUST be JSON (Content-Type: application/json, body: {}). Plain text
  causes "JSON validation failed" error shown to user in Claude Code UI.

  Claude Code blocks on Stop hook — shows "running stop hook" animation while
  waiting for HTTP response. This is the UX window where imdone speaks.

  Hooks only fire in interactive PTY mode. --print and piped-stdin modes do NOT fire hooks.

imdone event handler (v0: Stop + Notification only):
  1. Filter: hook_event_name == Stop or Notification? Others → log + skip
  2. Debounce: same hook_event_name within 500ms → discard
  3. Queue with priority (Notification > Stop)
  4. Dequeue: one utterance at a time (TTS blocks queue)
  5. TTS: macOS `say -v Ava "yo your shit's done mf"` (blocks until done)
  6. STT (Stop only): run imdone-listen → max 30s → transcript
  7. Print "I heard: [transcript]" to terminal
  8. Inject: ptyChild.write(transcript + '\r')  ← \r not \n; claude uses carriage return

Queue model (pseudo-code):
  ON_EVENT(e):                           ← HTTP handler, called on every POST
    respond_200_immediately_with_json()  ← res.end('{}') with application/json header
    if e.hook_event_name in queue AND delta < 500ms: DISCARD
    queue.push(e, priority[e.hook_event_name])

  ASYNC_LOOP (main thread):             ← runs independently, consumes queue
    e = queue.pop()
    play_tts(e)                          ← spawned child process, awaited; 30s timeout
    if e.hook_event_name == 'Stop': run_stt_and_inject()  ← spawned child, result via ptyChild.write(transcript + '\r')

Queue rules:
  - Max depth: 5 events. If full, drop oldest. Log dropped events.
  - Deduplication by type: only one pending event per type (last-write-wins).

Implementation rules:
  - Always use spawn(binary, [args]) not exec('binary ' + args) — prevents shell injection
  - Event processing runs on main thread as async loop (no worker_threads). TTS and STT are child
    processes (non-blocking). PTY injection calls ptyChild.write() directly on main thread.
  - phrases.json validated on startup, not at speak-time. Bad JSON = startup error with clear message.
  - ~/.imdone/ directory created on first run, not lazily.
  - .claude/settings.json path is relative to process.cwd() (the directory where imdone is invoked),
    not home. Users run imdone from their project root; that's where .claude/ lives.
  - TTS voice name (e.g., "Ava") is a constant in phrases.json, not hardcoded in say invocations.
  - Startup checks (in order): (1) claude binary on PATH, (2) say binary exists, (3) phrases.json
    valid, (4) settings.json valid if it exists, (5) port available. Any failure = clear error + exit.
  - PTY resize: forward SIGWINCH → ptyChild.resize(cols, rows)
  - PTY exit: when claude exits, imdone exits with same code.
```

**Key constraint:** HTTP server must return 200 immediately before TTS/STT. Process events asynchronously on the main thread via async/await. TTS and STT run as spawned child processes, not blocking the event loop. No worker_threads — PTY handle lives on main thread and must be written there.

---

## STT Technology Stack

### Decision: SFSpeechRecognizer (v0) + whisper.cpp (upgrade)

| Option | Accuracy | Setup | Offline |
|--------|----------|-------|---------|
| SFSpeechRecognizer | Good for short commands ("yes", "ship it", "stop") | Zero — built into macOS | Mostly (verify en-US locale) |
| whisper.cpp | Better for technical instructions ("fix the auth bug in users.ts") | ~3 min compile + 74MB model | 100% |

v0 uses SFSpeechRecognizer. If offline verification fails (some locales require Apple network), default to whisper.cpp.

Upgrade: `imdone --setup-whisper` compiles whisper.cpp with Metal, downloads base model.

### imdone-listen Parameters (v0 defaults)

- Max recording duration: 30 seconds
- Silence detection threshold: 1.5 seconds ends recording
- Sample rate: 16kHz
- Output: plain text to stdout, one line

---

## Voice Injection: Direct PTY Injection (v0)

User speaks → transcript prints to terminal → injected directly into Claude Code via PTY stdin. No paste required.

```
I heard: add tests for the auth module
[injected directly into claude — no paste needed]
```

**Risk accepted:** if STT mishears, the wrong transcript is sent to Claude Code immediately with no confirmation window. The "I heard: X" line is printed first so the developer sees what was injected. Recovery: manually correct in Claude Code. A future "say STOP" abort command could cancel injection (v0.1).

**Why direct injection is possible:** `imdone` spawns Claude Code via node-pty and holds a reference to the PTY child process. Injection is `ptyChild.write(transcript + '\n')` — identical to the developer typing and pressing Enter.

**Edge case:** STT fires while Claude Code is mid-output. The written bytes go into the PTY input buffer and are consumed when Claude Code next reads stdin. Needs spike verification that buffered input doesn't get garbled.

---

## Version Boundaries

| Version | What ships |
|---------|-----------|
| v0 demo | TTS-only. `imdone` spawns claude, Stop event → `say` fires. Record the clip. Tweet it. |
| v0 product | TTS + SFSpeechRecognizer STT + direct PTY injection. Full loop. One command. |
| v0.1 | "Say STOP" abort window before injection. Removes the mishear risk. |

Delivery order within v0: ship TTS milestone first (the demo), then merge STT+injection.

---

## Failure Modes

| Failure | User sees |
|---------|-----------|
| Claude Code exits unexpectedly | PTY child exits → imdone exits with same code. Expected behavior. |
| PTY child crashes | imdone catches child exit event, prints error, exits cleanly. |
| STT mishears + injects wrong text | Wrong prompt sent to Claude Code. No recovery in v0. Developer corrects manually. "Say STOP" abort in v0.1. |
| STT fires while Claude Code is mid-output | Transcript buffered in PTY stdin, consumed when Claude next reads input. Needs spike verification. |
| Port 51234 in use | `imdone` exits: "Port 51234 in use. Set IMDONE_PORT env var." No auto-increment (stale hook URLs). |
| `say` fails | Falls back to `osascript -e 'display notification "Task done"'` |
| `say` hangs | Killed after 30s timeout. Worker logs warning and continues processing queue. |
| `claude` binary missing | Detected at startup. imdone exits: "`claude` not found on PATH. Install Claude Code first." |
| `say` binary missing | Detected at startup. imdone exits: "macOS `say` command not found. macOS 12+ required." |
| STT: no speech in 30s | Prints "No speech detected. Continuing." Claude stays paused. User can retry. |
| STT: low confidence | Prints transcript anyway. User corrects before pasting. |
| Microphone permission denied | Prints instructions for System Settings > Privacy > Microphone. |
| SFSpeechRecognizer requires network | Detects failure, prints "Run `imdone --setup-whisper` to install local model." |
| Clipboard overwritten | Prints transcript to terminal as backup. |
| imdone-listen wrong arch | Detected on spawn (EACCES/exec format error). Prints "Binary arch mismatch — run `imdone --diagnose`." |
| Malformed POST body | Returns 200 OK. Logs parse error with request details. Does not crash. |
| phrases.json malformed | Detected at startup, not at speak-time. Exits with clear error and file path. |
| .claude/settings.json malformed | Startup exits: "settings.json is not valid JSON — fix it and re-run imdone. Path: [path]". Never silently overwrites. |

---

## Open Questions — RESOLVED (spike 2026-04-08)

1. **HTTP hook payload schema:** VERIFIED. See payload schemas above. Field is `hook_event_name`
   (not `type`). HTTP response must be JSON `{}` — plain text causes visible error in Claude Code UI.

2. **SFSpeechRecognizer offline:** CONFIRMED. `supportsOnDeviceRecognition: true` on macOS
   (tested on Apple Silicon, macOS Darwin 25.2). No network required for en-US.

3. **Swift binary packaging:** APPROACH CONFIRMED. GitHub Actions matrix build (macos-14 arm64 +
   macos-13 x86_64). npm optionalDependencies + cpu field. node-pty prebuilt binaries need
   `chmod +x spawn-helper` via postinstall script — they ship without execute permission.

4. **Claude Code Stop hook behavior:** CONFIRMED BLOCKS. Claude Code shows "running stop hook"
   animation and waits for HTTP response before continuing. This is the speaking window.
   Hooks only fire in interactive PTY mode — not in --print or piped stdin.

5. **PTY stdin injection timing:** CONFIRMED SAFE. Injected text is buffered correctly and
   consumed when the shell reads stdin. No garbling observed. Use `\r` (not `\n`) for Enter.

---

## Spike Checklist (Day 1)

```bash
# 1. Minimal server
node -e "require('http').createServer((req,res) => {
  let b=''; req.on('data',d=>b+=d);
  req.on('end',()=>{console.log(b); res.end('ok')});
}).listen(51234)"

# 2. Add to .claude/settings.json
{
  "hooks": {
    "Stop": [{ "type": "http", "url": "http://localhost:51234/event" }]
  }
}

# 3. Run claude, complete a task, examine POST body
# 4. Test: say "yo your shit is done"
# 5. Test: SFSpeechRecognizer offline (turn off wifi)
```

---

## Distribution

```
npm install -g imdone-mf
imdone                     ← starts claude + voice layer. that's it.
```

- `imdone` Node.js CLI
- Pre-compiled `node-pty` binaries (arm64 + x86_64, shipped in package — no user compilation)
- Pre-compiled `imdone-listen` Swift binary (arm64 + x86_64 via optionalDependencies)
- Default `~/.imdone/phrases.json` created on first run
- `.claude/settings.json` hooks auto-configured on first run

---

## Diagnostics

`imdone --diagnose` checks and reports:
- [ ] HTTP server is running on :51234
- [ ] .claude/settings.json has correct hook config (auto-written on first run)
- [ ] `say` command works (plays 1-second test tone)
- [ ] Microphone permission granted
- [ ] phrases.json exists and is valid JSON
- [ ] imdone-listen binary found and correct arch
- [ ] whisper.cpp installed (if --setup-whisper was run)

Run this when something isn't working. Also: `imdone --test-voice` fires a fake Stop event to test the full TTS path without needing Claude Code running.

---

## Test Plan (v0)

Framework: Jest or Vitest (Node.js). Mock `say`, mock `imdone-listen`.

| Test | What it checks |
|------|----------------|
| HTTP handler — Stop event | POST {type:"Stop"} → say called with correct phrase |
| HTTP handler — Notification event | POST {type:"Notification"} → say called |
| HTTP handler — unknown type | POST {type:"Foo"} → say NOT called, logged |
| HTTP handler — malformed JSON | POST "not json" → 200 returned, no crash |
| Debounce | Two Stop events <500ms → say called once |
| Queue cap | 6 events → first dropped, last 5 processed |
| Queue priority | Notification + Stop queued → Notification spoken first |
| phrases.json — valid | Loads and returns correct phrase for event type |
| phrases.json — missing | Returns default phrase, no crash |
| phrases.json — malformed | Startup error with filepath, clear message |
| say timeout | Mock say to hang → killed after 30s, worker continues |
| PTY injection | Mock ptyChild.write → called with transcript + '\n' after STT |
| Hook setup — every launch | .claude/settings.json hook URL updated to match current port on every start |
| Hook setup — IMDONE_PORT override | IMDONE_PORT=12345 → hook URL written as localhost:12345 |
| Hook setup — existing config | Existing settings.json merged, other keys not overwritten |
| Hook setup — malformed settings.json | Invalid JSON → startup error with filepath, no overwrite |

---

## Next Steps (ordered)

1. **Spike** — HTTP hook payload schema + SFSpeechRecognizer offline + PTY stdin injection timing. (1 day. Gates everything.)
2. **TTS on Stop** — HTTP server + node-pty spawning claude + `say`. Record the viral clip. (2 hours after spike.)
3. **First-run hook setup** — Auto-write .claude/settings.json. (CC: ~10min.)
4. **phrases.json** — Default phrase set, ~10 per event type. (1 hour.)
5. **Tests** — Jest/Vitest, ~13 unit tests. (CC: ~20min.)
6. **imdone-listen** — Swift CLI, arm64+x86_64, GitHub Actions matrix build. (1 day.)
7. **Direct PTY injection** — STT → ptyChild.write(transcript + '\n'). v0 full loop complete. (2 hours.)
8. **`--diagnose` command** — Checklist of all system deps. (CC: ~15min.)

---

## Document History

| Date | Change |
|------|--------|
| 2026-04-08 | Initial draft from /office-hours + /plan-ceo-review session. 3x adversarial review. Quality score 8/10. |
| 2026-04-08 | CEO review pass 2: competitive positioning added, queue cap, say timeout, spawn-not-exec, startup validation, print-only confirmation, GH Actions matrix build, test plan, --diagnose command. |
| 2026-04-08 | Architecture revision: single-terminal UX via node-pty (pre-compiled binaries), auto hook setup on first run, direct PTY stdin injection replacing clipboard path. |
