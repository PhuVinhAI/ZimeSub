import { open as pluginOpen } from '@tauri-apps/plugin-dialog'

/**
 * Show the OS folder picker. Returns the absolute path the user selected
 * or `null` when the user dismisses the dialog.
 *
 * Used by the Create Project modal's "Chọn thư mục" button. The
 * underlying plugin can return `string`, `string[]` (when `multiple`),
 * or `null` — we always ask for single-selection so the only shapes are
 * `string | null` here.
 */
export async function pickFolder(title: string): Promise<string | null> {
  const result = await pluginOpen({
    directory: true,
    multiple: false,
    title
  })
  if (result === null) return null
  if (typeof result === 'string') return result
  return null
}

/**
 * Show the OS multi-file picker filtered to `.mkv`. Returns the array of
 * absolute paths the user selected, or `[]` when they dismiss the dialog
 * or pick nothing.
 *
 * Used by the "Thêm Episode…" button as an alternative to drag-drop —
 * keyboard-only users follow this path. The MKV-only filter is enforced
 * on the OS side; we do not re-check extensions on the result, but the
 * caller still treats the returned list as untrusted user input and
 * routes it through the same validation as drag-drop for consistency.
 */
export async function pickMkvFiles(title: string): Promise<string[]> {
  const result = await pluginOpen({
    directory: false,
    multiple: true,
    title,
    filters: [{ name: 'MKV video', extensions: ['mkv'] }]
  })
  if (result === null) return []
  if (Array.isArray(result)) return result
  return [result]
}

/**
 * Show the OS single-file picker filtered to `.mkv`. Returns the
 * absolute path the user selected or `null` when they dismiss. Used
 * by the `Relocate…` button on a `MissingSource` Episode (slice 0012).
 */
export async function pickSingleMkv(title: string): Promise<string | null> {
  const result = await pluginOpen({
    directory: false,
    multiple: false,
    title,
    filters: [{ name: 'MKV video', extensions: ['mkv'] }]
  })
  if (result === null) return null
  if (typeof result === 'string') return result
  return null
}
