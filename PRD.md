# PRD: im done mf

**Status:** v0 decisions locked — ready for architecture planning.

---

## 1. What the product is

**im done mf** is an open-source **voice layer** around **Claude Code**. It runs as a thin CLI wrapper (`imdone` instead of `claude`), observes Claude Code's lifecycle events via its native Hooks system, and **only speaks when something actually needs the human** — task done, error blocking progress, approval required, idle timeout, or cost threshold hit. When it speaks, the tone is **direct, irreverent, and profane by default**. You respond out loud; it interprets your voice and feeds the next instruction back into Claude Code. No terminal-watching, no keyboard-babysitting — just vibes and the occasional check-in.

**Core user promise:** fewer interruptions, stronger interrupts — silence when nothing matters, clarity when something does.

---

## 2. What the product is not (non-goals)

Saying "no" early prevents scope creep and sets expectations for contributors.


| It is **not**…                                         | Why that matters                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A replacement for Claude Code                          | Wraps and extends the dev loop; does not reimplement the agent.                                                    |
| A continuous narrator / "read the terminal to me" tool | No ambient play-by-play. Speaking is event-gated and rare by design.                                               |
| A full voice IDE or coding-by-voice system             | No ambition to voice-navigate files, refactor by dictation, or replace the editor.                                 |
| A guarantee of 100% hands-free                         | Some prompts, auth, CAPTCHAs, or edge cases still need the screen; the product degrades gracefully.                |
| A surveillance or "bossware" logger                    | Background observation is local, purpose-limited, and transparent.                                                 |
| A multi-platform product at v0                         | macOS only for v0. Linux/Windows come later.                                                                       |
| A daemon or background service                         | It's a wrapper process — when you kill it, it's gone. No persistent background agents.                             |
| A product with unchecked voice command execution       | All voice actions include a 3-second read-back ("I heard X — proceeding in 3s, say STOP to cancel") before acting. |


---

## 3. Decisions made (answers to all open questions)

### Demand & wedge


| #   | Question                       | Decision                                                                                                                                                                        |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Who is the first user?         | Any developer using Claude Code — not just macOS, not just solo devs.                                                                                                           |
| Q2  | What do they do today instead? | Alt-tab terminal-watching, stare-at-screen ambient monitoring, walking away with no idea when it finishes, phone timers, or relying on Claude Code's own desktop notifications. |
| Q3  | Minimum magic for v0?          | All five: `task_complete`, `approval_needed`, `error/blocked`, `idle_timeout`, `cost_warning`.                                                                                  |


### Integration surface


| #   | Question                    | Decision                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q4  | How to observe Claude Code? | **Native Claude Code HTTP Hooks** (configured in `.claude/settings.json`). `imdone` runs a local HTTP server on `:51234`. Claude Code POSTs lifecycle events to it. Zero invasiveness — official API. IPC architecture: HTTP server chosen over PTY wrapper and pure hook scripts (see DESIGN.md).                                                                       |
| Q5  | Voice I/O stack?            | **TTS: macOS `say` command** (fully offline, built-in). **STT v0: macOS SFSpeechRecognizer** (offline, built-in, zero setup — works for short commands like "yes", "ship it", "stop"). **STT upgrade: whisper.cpp** via `imdone --setup-whisper` (better for technical instructions; opt-in). Clipboard injection for v0 voice response. File watcher injection in v0.1. |


### Trigger model


| #   | Question             | Decision                                                                                                                                                     |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q6  | "Speak now" events   | `task_complete`, `approval_needed`, `error/blocked`, `idle_timeout`, `cost_warning`                                                                          |
| Q7  | "Never speak" events | Every tool call (file read/write/search), streaming thinking output, lint/test line-by-line output, successful low-stakes steps (git add, npm install, etc.) |


### Safety & control


| #   | Question                   | Decision                                                                                                                                                                     |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q8  | Voice command scope?       | **Full natural language** — but always with a 3-second read-back and cancellation window before acting. ("I heard 'ship it' — proceeding in 3 seconds. Say STOP to cancel.") |
| Q9  | Mishear / silence timeout? | Repeat the prompt **once** after ~10 seconds, then pause and wait indefinitely for manual confirmation.                                                                      |
| Q10 | SFW mode from day one?     | No — ship profanity-always-on for v0. Keep it simple.                                                                                                                        |


### Experience & brand


| #   | Question                   | Decision                                                                                      |
| --- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Q11 | Profanity style?           | Every message — fully committed to the brand.                                                 |
| Q12 | User-customizable phrases? | Yes — `~/.imdone/phrases.json` ships with defaults and can be freely edited. No forks needed. |


### Distribution


| #   | Question          | Decision                                                                                                                                                                       |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q13 | Target OS for v0? | **macOS only.** whisper.cpp with Metal acceleration runs best here; keep v0 focused.                                                                                           |
| Q14 | Install shape?    | `**npm install -g imdone-mf`** — installs a thin CLI wrapper. Users run `imdone` instead of `claude`. No daemon, no background service. One process; when it exits, it's gone. |


### Success metrics


| #   | Question                  | Decision                                                                                                                                                                                                                                                            |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q15 | How do you know v0 works? | (a) Don't check the terminal at all during a session, (b) <2 false/unnecessary interruptions per hour, (c) can walk away mid-task and get called back at the right moment, (d) voice response continues the task correctly — no keyboard needed for the happy path. |


---

## 4. Open questions (v1 territory — not v0)

These were explicitly deferred:

- Linux / Windows (WSL2) support
- Persona toggle (SFW mode, custom voice character)
- Non-Claude-Code agent support (Cursor, Cline, Continue, etc.)
- Cloud TTS/STT option for users who want higher voice quality and accept the API dependency
- Whisper model size selection (tiny vs. base vs. small — tradeoff of speed vs. accuracy)

---

## 5. Document history


| Date       | Change                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-08 | Initial draft from founder description + discovery questions.                                                                                                                  |
| 2026-04-08 | All 15 questions answered; decisions locked; PRD updated to reflect v0 scope.                                                                                                  |
| 2026-04-08 | IPC architecture locked (HTTP server, see DESIGN.md). STT stack updated: SFSpeechRecognizer as v0 default, whisper.cpp as opt-in upgrade. Voice injection v0 = clipboard path. |
