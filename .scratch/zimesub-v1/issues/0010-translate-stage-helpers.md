---
title: "Translate stage helpers (open folder, draft, paste back, StylePatch)"
labels: [done]
type: AFK
status: done
blocked_by: [0007]
user_stories: [35, 36, 37, 38, 39, 40, 41]
---

# 0010 — Translate stage helpers (open folder, draft, paste back, StylePatch)

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

When an Episode has `ExtractedSub`, the per-Episode panel exposes the Translate stage. Four buttons let the user: open the EpisodeFolder in Explorer; create the `TranslationDraft` `.ass.txt`; paste back a full translated ASS to produce `TranslatedSub`; paste a `[V4+ Styles]` section to patch `TranslatedSub` via `StylePatch`. A stale-render badge appears if `Render` exists with mtime older than `TranslatedSub`.

ZimeSub does NOT call any AI API. Translation happens externally; this slice only provides the helper plumbing.

## Status

Done — implemented in commit on `master`.

## Acceptance criteria

- [x] Translate panel visible on Episodes whose `EpisodeState >= Extracted` (i.e. `<basename>.eng.ass` exists); collapsed/hidden otherwise.
- [x] **Button 1 — "Mở thư mục"**: opens the EpisodeFolder in Windows Explorer via `tauri-plugin-opener`.
- [x] **Button 2 — "Tạo file .ass.txt"**: copies `<basename>.eng.ass` to `<basename>.eng.ass.txt` in the same folder. If target exists, confirm overwrite.
- [x] **Button 3 — "Dán bản dịch"**: opens a modal with a large textarea (Geist Mono, min 20 rows). User pastes the full translated ASS, clicks "Lưu". App writes `<basename>.vietsub.ass`. If target exists, confirm overwrite via in-modal banner.
- [x] **Button 4 — "Dán [V4+ Styles]"**: enabled only when `<basename>.vietsub.ass` exists. Opens a modal with a textarea. Validation: the input must contain a line starting with `[V4+ Styles]` (exact, case-sensitive) and the next non-blank line must be a `Format:` header. If not, modal shows an error and refuses to save. On save, `StylePatch` runs: parse the existing TranslatedSub by sections, replace exactly the `[V4+ Styles]` section with the pasted block, leave other sections (`[Script Info]`, `[Events]`, etc.) untouched, write atomically (tmp file + rename).
- [x] If a `Render` (`<basename>.VietSub.mp4`) exists and its mtime is older than `<basename>.vietsub.ass`'s mtime, the Episode row shows a yellow badge "Render lỗi thời".
- [x] `EpisodeState` transitions correctly per the PRD's `derive_state` pseudocode: `Extracted` → `Translating` (after `.ass.txt` exists but no `.vietsub.ass`) → `Translated` (after `.vietsub.ass` exists).
- [x] All UI strings Vietnamese.

## Implementation notes

### Files created

- `src-tauri/src/` — none (extended existing `ass_ops.rs` / `episode_state.rs` / `commands.rs`).
- `src/api/translate.ts` — IPC bindings (`episodeOpenFolder`, `episodeMakeTranslationDraft`, `episodeWriteTranslated`, `episodeStylePatch`) plus the `TARGET_EXISTS` / `NO_TRANSLATED_SUB` sentinel string constants the panel matches against.
- `src/views/project/translate/TranslatePanel.tsx` — per-Episode helper strip mounted below the row when `hasExtractedSub`; renders four buttons + the yellow "Render lỗi thời" badge driven by `is_render_stale`.
- `src/views/project/translate/DraftOverwriteConfirmModal.tsx` — single-shot confirm modal for the "Tạo file .ass.txt" button when the draft already exists. No "không hỏi lại" memory (draft is cheap to regenerate).
- `src/views/project/translate/PasteTranslationModal.tsx` — large Geist Mono textarea (22 rows) for the full translated ASS; in-modal yellow banner on `TARGET_EXISTS` then "Ghi đè và lưu" re-invokes with `overwrite = true`.
- `src/views/project/translate/PasteStylesModal.tsx` — `[V4+ Styles]` paste modal with client-side validation (header presence + Format line) that mirrors the backend's `validate_styles_block`. The "Áp dụng" button is disabled until validation passes; the inline danger banner explains *why*.

### Files modified

- `src-tauri/src/ass_ops.rs` — added `make_draft`, `write_translated` (atomic tmp + rename), `replace_styles_section`, `patch_styles_in_place` (pure helper), `validate_styles_block`, plus the `AssOpsError` enum carrying Vietnamese display messages. 18 new tests covering copy/overwrite/missing-source, atomic-write semantics, validator edge cases (lowercase header rejected, blank lines between header and Format tolerated, missing Format detected), and section-bound detection (styles section as last section, CRLF normalisation in the pasted block).
- `src-tauri/src/episode_state.rs` — `EpisodeArtifacts` now carries `has_translation_draft` / `has_translated_sub` / `has_render` (real derivations replacing the slice 0007 placeholders) plus the new `is_render_stale` field driven by mtime comparison. 5 new tests covering the three artefact flags + the stale-vs-fresh render mtime check (uses a 100 ms sleep between writes so the OS mtime resolution ticks).
- `src-tauri/src/commands.rs` — added four Tauri commands (`episode_open_folder`, `episode_make_translation_draft`, `episode_write_translated`, `episode_style_patch`) plus a `resolve_episode_folder` helper shared by all four. The frontend's overwrite flow uses the `TARGET_EXISTS` sentinel string instead of a typed error so a single round-trip is enough; `episode_style_patch` re-validates server-side as defence-in-depth. `EpisodeArtifactsView` now also serialises `is_render_stale` over the IPC bridge.
- `src-tauri/src/lib.rs` — registered the four new commands in the `invoke_handler!` macro.
- `src-tauri/capabilities/default.json` — added `opener:allow-open-path` so `tauri_plugin_opener::open_path` doesn't reject when called from the backend command (the per-URL permission only covered the existing onboarding download button).
- `src/api/extract.ts` — `EpisodeArtifactsView` extended with `is_render_stale`.
- `src/stores/jobs.ts` — `EpisodeArtifactState` extended with `hasTranslationDraft` / `hasTranslatedSub` / `hasRender` / `isRenderStale`; `applyArtifactSnapshot` maps the new wire fields.
- `src/views/project/ProjectView.tsx` — the Episode row is now a `flex-col` with the existing top-row layout untouched and the new `<TranslatePanel>` mounted below when `hasExtractedSub` is true. Imports the new component. The top-row separator stays at the `<li>` level so the strip + buttons sit inside the same border block.

### Files deleted

- None.

### Notes on design choices

- **Atomic writes**: both `write_translated` and `replace_styles_section` go through a `<target>.tmp` sibling + rename. The crash-recovery pass from slice 0008 (`clean_stale_artifacts`) deletes 0-byte `.ass` and `.mp4` artefacts on project open, but the tmp dance prevents a mid-write crash from ever producing one in the first place. The tmp cleanup is best-effort on rename failure so a bad disk doesn't leak `*.tmp` siblings into EpisodeFolders.
- **Validation duplicated client + server**: the modal disables the save button until the client-side validator passes, giving the user real-time feedback. The backend re-runs `validate_styles_block` before writing because the IPC bridge is no real trust boundary against a future automated client but it keeps the on-disk file from ever holding an invalid styles section.
- **Sentinel strings over typed errors**: `TARGET_EXISTS` and `NO_TRANSLATED_SUB` are returned as plain string error payloads. Tauri's `Result<_, String>` IPC shape doesn't carry typed variants cheaply, and the panel's in-modal banner needs to distinguish "already exists" from a generic I/O error to render the right copy — string match keeps the call site free of any custom rejection plumbing.

## Blocked by

- 0007
