# Changelog

## [0.1.2] — 2026-04-10

### Fixed

- STT reliable across all rounds: switched child process `exit` → `close` event so transcript data is always fully read before the result is evaluated (race condition on fast machines)
- Notification TTS now plays immediately — 800ms audio-session teardown delay removed; macOS audio output (say/afplay) and audio input (AVAudioEngine) are separate hardware paths with no session conflict
- "Listening..." prompt appears instantly after TTS ends (~50ms teardown vs ~1.8s before)
- Error 1110 ("Retry") from SFSpeechRecognizer no longer aborts the session prematurely — window stays open so the recognizer can retry internally and process buffered speech

### Changed

- Silence timeout: 1.5s → 2.0s (more forgiving mid-sentence pauses)
- Max recording duration: 30s → 60s

---

## [0.1.1] — 2026-04-09

### Fixed

- Hook event names normalized — handles `hook_event_name`, `hookEventName`, `event_name`, `eventName`, and `type` field variants
- Unsupported hook types (PreToolUse, PostToolUse, etc.) logged and skipped cleanly instead of silently dropped
- Three-tier TTS: local audio files → ElevenLabs → macOS `say` fallback chain
- `imdone-listen` binary downloaded automatically on `npm install` via postinstall script
- Custom audio file support: drop `.mp3`/`.wav`/`.aiff`/`.m4a` into `~/.imdone/audio/stop/` or `~/.imdone/audio/notification/`

---

## [0.1.0] — 2026-04-08

First release.

### Added

- HTTP server on `:51234` receives Claude Code lifecycle hook events (Stop, Notification)
- PTY wrapper spawns `claude` — terminal passthrough works exactly as normal
- TTS via macOS `say` — speaks on Stop and Notification events, hood/AAVE voice by default
- STT via SFSpeechRecognizer — fully offline, zero setup, activates after TTS completes
- Direct PTY stdin injection — voice transcript injected into Claude Code, no paste required
- Auto-configures `.claude/settings.json` HTTP hooks on every launch
- `~/.imdone/phrases.json` — created on first run, freely editable, no fork needed
- `imdone-listen` Swift CLI — universal binary (arm64 + x86_64), ad-hoc signed, auto-downloaded on install
- `--diagnose` command — checks all system deps with pass/fail and fix hints
- Debouncing (500ms), priority queue (Notification > Stop), queue cap (5), TTS 30s timeout
- Startup validation — clear errors for missing `claude`, missing `say`, bad JSON, port conflict
- 17 unit tests (Vitest)

### Voice

Default voice: Rocko (English (US)). Customizable via `~/.imdone/phrases.json`.
