# pi-job-progress

A pi extension that draws a live progress bar below the editor for a long background job, read from its log file. It redraws every 2 seconds with no agent turn.

```
chip backfill [█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 5% 2,200/41,488 · 2582 chips linked · $0.1017 spend · 5.4/s · eta 2.0h
```

## Demo

Illustrative mock-up of the widget (not a screen capture), mid-run:

```
 ┌ you ───────────────────────────────────────────────────────────────────────┐
 │ > _                                                                        │
 └────────────────────────────────────────────────────────────────────────────┘
  chip backfill [████████████░░░░░░░░░░░░░░░░░░] 41% 17,010/41,488 · 20,115 chips linked · $0.8420 spend · 5.4/s · eta 1.3h
  mb releases   [██████████████████████████████] 100% 1,700/1,700 · 5 errors · 21.2/s · eta 0s ✓ finished
```

## Use

Ask the agent to track a job, or call the `job_progress` tool:

- `start`: `id`, `logFile`, `total`, and either `preset` or `pattern`. `pattern` is a JS regex whose group 1 is the done count; later groups are shown as extras. Pass `pid` so the bar shows finished or stopped when the process exits.
- `show`: a text bar now, for print and RPC modes with no TUI.
- `list`, `stop`.

`/progress` lists the jobs. `/progress hide [id|all]` and `/progress unhide [id|all]` hide or show bars in the current session only; other sessions are unaffected and hidden state resets on restart. `/progress stop <id>` removes a job for every session. Every session shows every job by default. Jobs persist in `~/.pi/agent/job-progress.json`.

Built-in preset: `chip-backfill`.

## Install

```
pi install git:github.com/aglowinthefield/pi-job-progress
```

or symlink `src/extension.ts` into `~/.pi/agent/extensions/`.

Status: only tested in print mode so far; the live widget draw hasn't been checked in the TUI.
