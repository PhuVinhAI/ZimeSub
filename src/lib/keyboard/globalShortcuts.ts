import { closeTopModal, hasOpenModal } from '../modal/modalStack'
import { registerShortcut } from './shortcut-registry'

/**
 * Install app-wide shortcuts. Call once at boot from `AppShell`.
 *
 * Slice 0001 wires only Escape → close top modal (the modal stack is empty
 * until later slices). Add Ctrl+N (slice 0004), Ctrl+, (settings), J/K
 * (episode list nav) here when those views land.
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
