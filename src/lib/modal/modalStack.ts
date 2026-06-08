import { createSignal, onCleanup, onMount } from 'solid-js'

/**
 * Modal stack tracking which modal is currently on top, so a single Escape
 * shortcut can pop it.
 *
 * Slice 0001 only ships the scaffold — modals appear in later slices
 * (track picker, paste-translation, confirm dialogs, etc.). Each modal calls
 * `useModal(closeFn)` on mount; Escape (wired in `installGlobalShortcuts`)
 * fires `closeTopModal()` which calls the top entry's `close` fn.
 */

interface ModalEntry {
  id: symbol
  close: () => void
}

const [stack, setStack] = createSignal<ModalEntry[]>([])

export function pushModal(close: () => void): symbol {
  const id = Symbol('modal')
  setStack(s => [...s, { id, close }])
  return id
}

export function popModal(id: symbol): void {
  setStack(s => s.filter(m => m.id !== id))
}

export function closeTopModal(): boolean {
  const current = stack()
  if (current.length === 0) return false
  const top = current[current.length - 1]
  top.close()
  setStack(current.slice(0, -1))
  return true
}

export function hasOpenModal(): boolean {
  return stack().length > 0
}

/**
 * Register `closeFn` as the active modal for the lifetime of this owner.
 * Cleans up on dismount even if `closeFn` was never called.
 */
export function useModal(closeFn: () => void): void {
  let id: symbol | undefined
  onMount(() => {
    id = pushModal(closeFn)
  })
  onCleanup(() => {
    if (id) popModal(id)
  })
}
