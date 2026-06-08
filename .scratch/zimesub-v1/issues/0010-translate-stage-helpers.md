---
title: "Translate stage helpers (open folder, draft, paste back, StylePatch)"
labels: [ready-for-agent]
type: AFK
blocked_by: [0007]
user_stories: [35, 36, 37, 38, 39, 40, 41]
---

# 0010 — Translate stage helpers (open folder, draft, paste back, StylePatch)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

When an Episode has `ExtractedSub`, the per-Episode panel exposes the Translate stage. Four buttons let the user: open the EpisodeFolder in Explorer; create the `TranslationDraft` `.ass.txt`; paste back a full translated ASS to produce `TranslatedSub`; paste a `[V4+ Styles]` section to patch `TranslatedSub` via `StylePatch`. A stale-render badge appears if `Render` exists with mtime older than `TranslatedSub`.

ZimeSub does NOT call any AI API. Translation happens externally; this slice only provides the helper plumbing.

## Acceptance criteria

- [ ] Translate panel visible on Episodes whose `EpisodeState >= Extracted` (i.e. `<basename>.eng.ass` exists); collapsed/hidden otherwise.
- [ ] **Button 1 — "Mở thư mục"**: opens the EpisodeFolder in Windows Explorer via `tauri-plugin-opener`.
- [ ] **Button 2 — "Tạo file .ass.txt"**: copies `<basename>.eng.ass` to `<basename>.eng.ass.txt` in the same folder. If target exists, confirm overwrite.
- [ ] **Button 3 — "Dán bản dịch"**: opens a modal with a large textarea (Geist Mono, min 20 rows). User pastes the full translated ASS, clicks "Lưu". App writes `<basename>.vietsub.ass`. If target exists, confirm overwrite via in-modal banner.
- [ ] **Button 4 — "Dán [V4+ Styles]"**: enabled only when `<basename>.vietsub.ass` exists. Opens a modal with a textarea. Validation: the input must contain a line starting with `[V4+ Styles]` (exact, case-sensitive) and the next non-blank line must be a `Format:` header. If not, modal shows an error and refuses to save. On save, `StylePatch` runs: parse the existing TranslatedSub by sections, replace exactly the `[V4+ Styles]` section with the pasted block, leave other sections (`[Script Info]`, `[Events]`, etc.) untouched, write atomically (tmp file + rename).
- [ ] If a `Render` (`<basename>.VietSub.mp4`) exists and its mtime is older than `<basename>.vietsub.ass`'s mtime, the Episode row shows a yellow badge "Render lỗi thời".
- [ ] `EpisodeState` transitions correctly per the PRD's `derive_state` pseudocode: `Extracted` → `Translating` (after `.ass.txt` exists but no `.vietsub.ass`) → `Translated` (after `.vietsub.ass` exists).
- [ ] All UI strings Vietnamese.

## Blocked by

- 0007
