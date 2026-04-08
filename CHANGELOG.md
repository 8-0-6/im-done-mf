# Changelog

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
