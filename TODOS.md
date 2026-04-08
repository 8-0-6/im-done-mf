# TODOS: im done mf

Last updated: 2026-04-08 (Sprint 2+3 complete: TTS on Stop, hook sync, phrases.json)

---

## v0 — Ship order (from DESIGN.md Next Steps)

- [x] **Spike** — all three verified (2026-04-08):
  1. HTTP hook payload: field is `hook_event_name`, response must be JSON `{}`, Claude blocks on Stop
  2. SFSpeechRecognizer offline: `supportsOnDeviceRecognition: true` confirmed
  3. PTY injection: safe mid-output, use `\r` not `\n` for Enter

- [x] **TTS on Stop** — HTTP server + node-pty spawning claude + `say`. Record the viral clip. (2026-04-08)
  - HTTP server on :51234, returns JSON `{}` immediately (plain text breaks Claude Code UI)
  - Hook settings format: `{ matcher: '', hooks: [{ type: 'http', url }] }` (verified schema)
  - node-pty spawns `claude`, stdout → terminal, keyboard → stdin
  - package.json postinstall script: `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`
  - Stop event → `say -v [voice] "[phrase]"` fires
  - Startup checks: claude on PATH, say exists, phrases.json valid, port free

- [x] **Hook setup (every launch)** — sync `.claude/settings.json` hook URL to current port on startup. (2026-04-08)
  - Read or create `.claude/settings.json` (ENOENT safe, die on invalid JSON)
  - Merge: set `hooks.Stop` and `hooks.Notification` to `http://localhost:${port}/event`
  - Preserve all other keys in settings.json
  - Atomic write: temp file → rename

- [x] **phrases.json** — default phrase set, hood/AAVE voice. Voice constant lives here too. (2026-04-08)
  - `~/.imdone/phrases.json` created on first run with defaults
  - Validated on startup (not at speak-time)
  - Voice field: `"voice": "Ava"` (used in all `say` invocations)

- [ ] **Tests** — Jest or Vitest, 17 unit tests (see DESIGN.md Test Plan):
  - HTTP handler: Stop, Notification, unknown type, malformed JSON
  - Debounce, queue cap, queue priority
  - phrases.json: valid, missing, malformed
  - say timeout
  - PTY injection
  - Hook setup: every launch, IMDONE_PORT override, existing config merge, malformed settings.json

- [ ] **imdone-listen** — Swift CLI for STT via SFSpeechRecognizer
  - arm64 + x86_64 binaries
  - GitHub Actions matrix build: macos-14 (arm64) + macos-13 (x86_64)
  - Binaries attached to GitHub Release
  - npm optionalDependencies + cpu field pulls correct arch on install
  - Gatekeeper: ad-hoc signing for v0 (right-click > Open)
  - Params: 30s max, 1.5s silence detection, 16kHz, stdout plain text

- [ ] **Direct PTY injection** — STT → `ptyChild.write(transcript + '\r')`. Full loop complete.
  - Use `\r` not `\n` — verified in spike; claude's PTY requires carriage return for Enter
  - Print "I heard: [transcript]" to terminal before injecting
  - No confirmation window in v0 (that's v0.1)

- [ ] **`--diagnose` command** — checklist of all system deps:
  - HTTP server reachable on :51234
  - .claude/settings.json has correct hook URL
  - `say` command works (1-second test tone)
  - Microphone permission granted
  - phrases.json exists and is valid JSON
  - imdone-listen binary found and correct arch
  - whisper.cpp installed (if --setup-whisper was run)

---

## v0.1 — After v0 ships

- [ ] **"Say STOP" abort window** — 3-second cancellation window before PTY injection fires.
  Removes the mishear risk. Replaces print-only confirmation.

- [ ] **`--setup-whisper`** — compiles whisper.cpp with Metal, downloads base model (~74MB).
  Upgrade path for users who need better STT accuracy on technical instructions.

---

## Deferred (v1+)

- Linux / Windows (WSL2) support
- Persona toggle (SFW mode, custom voice character)
- Non-Claude-Code agent support (Cursor, Cline, Continue)
- Cloud TTS/STT option
- Whisper model size selection
