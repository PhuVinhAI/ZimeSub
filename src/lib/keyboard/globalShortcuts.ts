import { closeTopModal, hasOpenModal } from '../modal/modalStack'
import { registerShortcut } from './shortcut-registry'

/**
 * Install app-wide shortcuts. Call once at boot from `AppShell`.
 *
 * Slice 0001 wired only Escape → close top modal. Slice 0004's Ctrl+N
 * ("Tạo project mới") lives directly on `AppShell` via
 * `useKeyboardShortcut` so it picks up disposal during HMR; this
 * installer stays minimal for boot-time bindings that have no owning
 * component yet. Ctrl+, (settings) and J/K (episode list nav) belong
 * in their respective slices.
 */
export function installGlobalShortcuts(): () => void {
  const offEscape = registerShortcut({
    combo: 'Escape',
    description: 'Đóng modal đang mở',
    handler: event => {
      if (hasOpenModal()) {
        event.preventDefault()
        closeTopModal()
      }
    }
  })

  return () => {
    offEscape()
  }
}
