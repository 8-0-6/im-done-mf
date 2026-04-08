# CLAUDE.md — im done mf

Context file for AI assistants. Read this before any session on this project.

---

## What this project is

**im done mf** is an open-source CLI tool that adds voice notifications to Claude Code. It listens to Claude Code lifecycle events via HTTP hooks and speaks when something needs the human's attention — profanely, by default.

Core user promise: walk away from your terminal. Get called back when Claude finishes, gets stuck, or needs approval. Speak your next instruction. Continue without touching the keyboard.

## Key files

| File | Purpose |
|------|---------|
| `PRD.md` | Product decisions, non-goals, success metrics |
| `DESIGN.md` | Architecture decisions, IPC approach, STT stack, failure modes |
| `CLAUDE.md` | This file — AI context |

## Architecture (read DESIGN.md for full detail)

- **IPC:** Claude Code HTTP hooks → local HTTP server (`imdone` runs on `:51234`)
- **TTS:** macOS `say` command (offline, built-in)
- **STT v0:** macOS SFSpeechRecognizer (offline, built-in)
- **STT upgrade:** whisper.cpp with Metal (`imdone --setup-whisper`)
- **Voice injection v0:** Clipboard + print (user pastes)
- **Voice injection v0.1:** File watcher (`~/.imdone/response.txt`)

## Key decisions made (do not re-open without strong reason)

1. **HTTP server architecture** — chosen over PTY wrapper and pure hook scripts. Supports the full voice-response loop.
2. **STT default is SFSpeechRecognizer** — not whisper.cpp. Zero setup. whisper.cpp is opt-in upgrade for accuracy.
3. **v0 voice injection = clipboard** — clipboard+print proves the loop before building file watcher.
4. **Fixed port 51234** — no auto-increment. Port conflict = process exits with error message.
5. **HTTP server returns 200 immediately** — events processed async in worker thread. Claude Code must not block on hook response.
6. **TTS then STT, sequential** — no overlapping audio. TTS plays, then mic activates. No echo/feedback loop.
7. **v0 event scope: Stop + Notification only** — other event types (PreToolUse, PostToolUse) are logged and skipped.
8. **Profanity always-on for v0** — no SFW mode, no toggle. Ship the personality first.
9. **macOS only v0** — Linux/Windows deferred.
10. **npm install -g distribution** — not Homebrew, not GitHub binary releases.

## Open questions (require spike before building)

1. HTTP hook payload schema — field names unverified. Run a debug server first.
2. SFSpeechRecognizer offline behavior — works offline for en-US on macOS 14+? Needs test.
3. Claude Code Stop hook behavior — does claude block/wait after firing Stop? Needs test.
4. Swift binary Gatekeeper — ad-hoc signing sufficient for v0?

## What NOT to do

- Do not re-open the IPC architecture question. HTTP server is decided.
- Do not add whisper.cpp as the default STT. It's an upgrade path.
- Do not build auto-port-increment. Fixed port is intentional.
- Do not add a daemon or background service. Single foreground process only.
- Do not ship SFW mode toggle in v0. Ship later.

## Distribution

```
npm install -g imdone-mf
imdone
```

## Skill routing

When the user's request matches an available skill, invoke it first:

- Product ideas, scope questions, "is this worth building" → invoke /office-hours
- Bugs, errors, unexpected behavior → invoke /investigate
- Ship, deploy, create PR → invoke /ship
- QA, test the site, find bugs → invoke /qa
- Code review, check my diff → invoke /review
- Architecture review, "lock in the plan" → invoke /plan-eng-review
- Design polish → invoke /design-review
- Update docs after shipping → invoke /document-release
- Save progress, resume → invoke /checkpoint
