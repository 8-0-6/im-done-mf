# Workflow: im done mf

Multi-agent orchestration design. Last updated: 2026-04-08.

---

## How we work

**You talk to one agent:** Claude Code in terminal. I orchestrate everything.

**You step away.** I ping you only when something needs you.

**Auto-start:** If /qa passes cleanly at the end of a sprint, I roll straight into the next sprint without waiting.

---

## When I ping you

| Trigger | What I send |
|---------|------------|
| Cursor task ready | "Cursor task: [copy-paste spec]" — you run it, say "done" |
| Decision needed | Single question, max 2 options, my recommendation |
| /qa or /health flags something I can't resolve | What failed, what I tried, what I need |
| All sprints done | Final summary |

I do NOT ping you when: /qa passes, /simplify makes minor fixes, or I'm mid-sprint.

---

## Sprint report format

```
SPRINT [n] DONE
Built: [what shipped]
QA: [pass / pass with fixes / needs you]
Health: [if /health ran]
Next: [sprint n+1 plan]
Cursor task: [copy-paste spec, or "none"]
Action needed: [yes — [what] / no]
```

If "Action needed: no" — you can just say "go" (or nothing, I'll start automatically).

---

## Tool routing

**Cursor** (mechanical, no context required):
- package.json, .gitignore, tsconfig.json, .npmrc
- Test file scaffolding (empty describe blocks)
- README, docs

**Claude Code** (requires DESIGN.md context or judgment):
- index.js (HTTP server, PTY spawn, async queue)
- phrases.json defaults
- Hook setup logic (settings.json merge)
- PTY resize, exit, injection wiring
- STT integration
- /simplify, /qa, /health runs

---

## Post-sprint automation

```
End of every sprint:
  1. /simplify  → note any changes
  2. /qa        → if fixable: fix + re-run; if needs judgment: ping user
  3. Auto-start next sprint (if QA passes) OR report to user (if QA needs them)

Every 3 sprints:
  /health → include in next ping
```

---

## Sprint map

| Sprint | What | Status |
|--------|------|--------|
| 1 | Spike — verify HTTP payload, SFSpeechRecognizer offline, PTY injection | DONE |
| 2 | TTS on Stop — HTTP server + node-pty + say | todo |
| 3 | Hook setup + phrases.json | todo |
| 4 | Tests (17 unit tests) | todo |
| 5 | imdone-listen Swift CLI + GitHub Actions | DONE |
| 6 | PTY injection full loop (STT → inject) | DONE |
| 7 | --diagnose command | DONE |
| 8 | Piper TTS opt-in (--setup-piper) | DONE |

Update status here as sprints complete.
