import { onCleanup } from 'solid-js'
import { registerShortcut, type ShortcutHandler } from './shortcut-registry'

/**
 * Solid composable to bind a keyboard shortcut for the lifetime of the
 * current owner (component / `createRoot`). Unregisters on cleanup.
 *
 * @example
 *   useKeyboardShortcut('Escape', () => closeModal(), 'Đóng modal')
 *   useKeyboardShortcut('Ctrl+N', () => openNewProjectModal())
 */
export function useKeyboardShortcut(
  combo: string,
  handler: ShortcutHandler,
  description?: string
): void {
  const unregister = registerShortcut({ combo, handler, description })
  onCleanup(unregister)
}
