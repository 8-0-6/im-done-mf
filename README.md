# im done mf

Voice layer for Claude Code. Speaks when your shit's done.

```
npm install -g imdone-mf
imdone
```

---

## What it does

You run `imdone` instead of `claude`. It wraps Claude Code and listens for lifecycle events via Claude Code's native HTTP hooks. Today it reacts to **Stop** and **Notification** hooks: it speaks, then (on Stop) listens and injects what you said into Claude Code. No paste required.

**macOS only. Requires Claude Code.**

---

## Install

```bash
npm install -g imdone-mf
```

That's it. No compilation. Pre-built binaries for arm64 and x86_64 are downloaded automatically.

### Requirements

- macOS 12+
- Node.js 18+
- [Claude Code](https://claude.ai/code) installed (`claude` on your PATH)

---

## Usage

```bash
imdone                        # starts Claude Code with voice layer
imdone "build me a todo app"  # pass a task directly
imdone --diagnose             # check all system dependencies
```

On first run, `imdone` auto-writes `.claude/settings.json` in your project directory with the HTTP hook config. You never touch that file manually.

---

## How it works

```
You run: imdone [task]

imdone starts:
  1. HTTP server on :51234 (receives Claude Code hook events)
  2. Claude Code via PTY (your terminal works exactly as normal)

When Claude Code fires a Stop or Notification hook:
  → imdone speaks the phrase out loud (three-tier TTS, see below)
On Stop only (after TTS):
  → mic opens (SFSpeechRecognizer, on-device)
  → prints "I heard: [transcript]" and injects it into Claude Code (`\r` = Enter)
Notifications do not run the listen/inject step.
```

**TTS priority order:**
1. **Local audio file** — any `.mp3`/`.wav`/`.aiff`/`.m4a` in `~/.imdone/audio/stop/` or `~/.imdone/audio/notification/`
2. **ElevenLabs** — if `ELEVENLABS_API_KEY` is set in your environment
3. **macOS `say`** — always-available fallback, zero config

---

## Customize phrases

Edit `~/.imdone/phrases.json` (created on first run):

```json
{
  "Stop": [
    "yo your shit's done motherfucker",
    "aye, task complete, what's next"
  ],
  "Notification": [
    "aye, claude needs you"
  ]
}
```

To use a specific `say` voice, add a `"voice"` field with any `say`-compatible name. Run `say -v ?` to list installed voices.

---

## Custom audio files

Drop your own clips into `~/.imdone/audio/` and they take priority over everything else:

```
~/.imdone/audio/
  stop/          ← played on Claude Code Stop events
    clip1.mp3
    clip2.mp3
  notification/  ← played on Notification events
    clip1.mp3
```

Supported formats: `.mp3`, `.wav`, `.aiff`, `.m4a`. A random clip is picked each time. If the folder is empty or missing, imdone falls through to ElevenLabs or `say`.

---

## Troubleshoot

```bash
imdone --diagnose
```

Checks: `claude` on PATH, `say` on PATH, `afplay` on PATH, local audio files (optional), ElevenLabs API key (optional), `.claude/settings.json` hook URL, `phrases.json` valid, `imdone-listen` binary present, port 51234 available.

**Port conflict:**

```bash
IMDONE_PORT=51235 imdone
```

**Microphone permission denied:** System Settings → Privacy & Security → Microphone → enable Terminal (or your terminal app).

---

## License

MIT