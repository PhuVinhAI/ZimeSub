---
title: "Install tools via winget + live log stream + re-probe"
labels: [ready-for-agent]
type: AFK
blocked_by: [0002]
user_stories: [2, 3, 5, 6]
---

# 0003 — Install tools via winget + live log stream + re-probe

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

From the Onboarding view, clicking "Cài đặt" next to a Missing/Outdated `RequiredTool` spawns `winget install` for that tool. Stdout/stderr stream live into a monospace terminal-style log panel. When winget exits, `ToolProbe` re-runs automatically and the badge updates. If winget is unavailable, fall back to opening the official download page + a "Tôi đã cài" re-probe button.

## Acceptance criteria

- [ ] Winget invocations: `winget install --id MKVToolNix.MKVToolNix -e --accept-package-agreements --accept-source-agreements` and `winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements`. Mkvmerge and mkvextract are both delivered by the MKVToolNix package; ffmpeg by Gyan.FFmpeg.
- [ ] Stdout and stderr lines stream into the UI as produced (no buffering until exit). Log panel uses Geist Mono, fixed-pitch, auto-scrolls to bottom on each new line.
- [ ] After winget exits (success or failure), `ToolProbe` re-runs. If the tool is now Ready, the badge flips and the gate is re-evaluated; if all 3 are Ready, Onboarding closes.
- [ ] If `winget` itself is not on PATH (Win 10 pre-1809 or restricted enterprise), the install button is replaced by:
  - "Mở trang tải" — opens the official download URL via `tauri-plugin-opener`
  - "Tôi đã cài" — triggers `ToolProbe`
- [ ] A "Quét lại" button in app Settings (reachable after Onboarding closes) re-runs detection without restart.
- [ ] The app itself does NOT request UAC elevation. winget's per-install UAC prompt is intentional.
- [ ] If a winget install fails (non-zero exit), the log panel stays visible with the captured error and a "Thử lại" button.
- [ ] Cancelling an install kills the winget child process. Partial install state is left to winget — the app does not delete files.
- [ ] All UI strings Vietnamese.

## Blocked by

- 0002
