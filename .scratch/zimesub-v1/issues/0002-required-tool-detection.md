---
title: "RequiredTool detection + Onboarding gate view"
labels: [ready-for-agent]
type: AFK
blocked_by: [0001]
user_stories: [1, 4, 7, 67]
---

# 0002 — RequiredTool detection + Onboarding gate view

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

When the app starts, detect whether `mkvmerge`, `mkvextract`, and `ffmpeg` are installed at acceptable versions per [ADR-0002](../../../docs/adr/0002-tooling-via-winget.md). If any are Missing or Outdated, show an Onboarding view that gates the rest of the app. If all three are Ready, fall through to the empty Main view from slice 0001. Tool paths + versions cache to `%APPDATA%\ZimeSub\settings.json`.

This slice does NOT install tools — it only detects and displays. Install lands in 0003.

Also bootstraps the app-level log file infrastructure since this is the first slice that writes logs.

## Acceptance criteria

- [ ] A detection routine probes each `RequiredTool`: try via `PATH` (e.g. via the `which` crate), fall back to the Windows default install path (e.g. `C:\Program Files\MKVToolNix\mkvmerge.exe`). On success, record absolute path + version parsed from `--version` stdout.
- [ ] Version floors enforced: `ffmpeg ≥ 4.0`, `MKVToolNix ≥ 60.0`. Below floor → `Outdated`. Not found → `Missing`. Found and ≥ floor → `Ready`.
- [ ] On app start, detection runs once and results are cached to settings.json. Cached results are reused on subsequent launches; cache is invalidated if a cached absolute path no longer exists on disk.
- [ ] Onboarding view shows a single panel listing the 3 RequiredTool rows. Each row: tool name, status badge (`Ready` accent / `Outdated` warn with current+minimum / `Missing` danger), and resolved absolute path when known.
- [ ] Onboarding view fully covers the Main app. Sidebar items, drag-drop, and project actions are inaccessible while gating. Bottom status bar is hidden during Onboarding.
- [ ] When all 3 are `Ready`, the app skips Onboarding and shows the empty Projects state from slice 0001.
- [ ] A "Quét lại" button on Onboarding re-runs detection and updates the UI.
- [ ] App-level log file (`%APPDATA%\ZimeSub\logs\zimesub.log`, rotated 5 × 2 MB) is initialised at app start. Detection results and errors are logged.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0001
