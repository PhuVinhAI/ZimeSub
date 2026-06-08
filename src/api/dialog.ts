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
