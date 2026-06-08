import { invoke } from '@tauri-apps/api/core'

/**
 * Translate-stage IPC bindings (slice 0010).
 *
 * Four helpers backing the four buttons in the per-Episode Translate
 * panel:
 *  1. {@link episodeOpenFolder} — Windows Explorer on the EpisodeFolder.
 *  2. {@link episodeMakeTranslationDraft} — copy `.eng.ass` → `.eng.ass.txt`.
 *  3. {@link episodeWriteTranslated} — atomic write of the pasted
 *     `<basename>.vietsub.ass`.
 *  4. {@link episodeStylePatch} — replace the `[V4+ Styles]` section in
 *     TranslatedSub with the pasted block.
 *
 * The overwrite flow uses a `TARGET_EXISTS` string sentinel returned
 * verbatim from the backend so the frontend can surface the in-modal
 * banner without a separate "does it exist" probe; the same sentinel
 * is exported here as a constant for callers to match against.
 *
 * Field names match the Rust `#[derive(Serialize)]` outputs 1:1.
 * See `src-tauri/src/commands.rs`.
 */

/** Sentinel rejection value returned by the backend when an overwrite
 *  was requested but the target file already exists and `overwrite =
 *  false`. The Translate panel matches against this exact string to
 *  decide whether to surface the in-modal confirm banner vs a generic
 *  danger toast. */
export const TARGET_EXISTS_SENTINEL = 'TARGET_EXISTS'

/** Sentinel rejection value for {@link episodeStylePatch} when the
 *  EpisodeFolder doesn't have a `<basename>.vietsub.ass` to patch. The
 *  UI disables the button in that state but the guard is here as
 *  defence-in-depth. */
export const NO_TRANSLATED_SUB_SENTINEL = 'NO_TRANSLATED_SUB'

/** Result shape for {@link episodeMakeTranslationDraft}. Drives the
 *  toast copy — "Đã tạo bản nháp" vs "Đã ghi đè bản nháp". */
export interface MakeDraftOutcome {
  existed_before: boolean
}

/**
 * Open the EpisodeFolder in Windows Explorer via `tauri-plugin-opener`.
 * The backend rejects with "Thư mục Episode không tồn tại" when the
 * folder was deleted out from under ZimeSub.
 */
export async function episodeOpenFolder(folder: string, episodeId: string): Promise<void> {
  return invoke<void>('episode_open_folder', { folder, episodeId })
}

/**
 * Copy `<basename>.eng.ass` → `<basename>.eng.ass.txt` so the user can
 * paste the content into AI services that reject the `.ass` extension.
 *
 * `overwrite = false` + existing target → rejects with
 * {@link TARGET_EXISTS_SENTINEL}. Re-invoke with `overwrite = true`
 * after the user confirms via the in-modal banner.
 *
 * Resolves to `{ existed_before }` so the caller's toast can flip
 * between "Đã tạo" and "Đã ghi đè".
 */
export async function episodeMakeTranslationDraft(
  folder: string,
  episodeId: string,
  overwrite: boolean
): Promise<MakeDraftOutcome> {
  return invoke<MakeDraftOutcome>('episode_make_translation_draft', {
    folder,
    episodeId,
    overwrite
  })
}

/**
 * Atomic write of `<basename>.vietsub.ass` from the user's pasted full
 * ASS blob. Same overwrite semantics as
 * {@link episodeMakeTranslationDraft} — rejects with
 * {@link TARGET_EXISTS_SENTINEL} when `overwrite = false` and the
 * TranslatedSub already exists.
 */
export async function episodeWriteTranslated(
  folder: string,
  episodeId: string,
  content: string,
  overwrite: boolean
): Promise<void> {
  return invoke<void>('episode_write_translated', {
    folder,
    episodeId,
    content,
    overwrite
  })
}

/**
 * Replace the `[V4+ Styles]` section in `<basename>.vietsub.ass` with
 * the pasted block. The backend re-validates the block (must contain
 * `[V4+ Styles]` exactly + a `Format:` line) before writing; rejects
 * with a Vietnamese error message on validation failure or
 * {@link NO_TRANSLATED_SUB_SENTINEL} when the file doesn't exist.
 */
export async function episodeStylePatch(
  folder: string,
  episodeId: string,
  stylesBlock: string
): Promise<void> {
  return invoke<void>('episode_style_patch', {
    folder,
    episodeId,
    stylesBlock
  })
}
