/**
 * Global keyboard shortcut registry.
 *
 * One module-level set of bindings + one `keydown` listener on `window`.
 * Components register/unregister via `useKeyboardShortcut`. The registry stays
 * pure so it is trivially unit-testable later; the listener is wired lazily
 * the first time anything is registered so importing this file has no side
 * effects until needed.
 */

export type ShortcutHandler = (event: KeyboardEvent) => void

export interface ShortcutBinding {
  /** A combo string like `Escape`, `Ctrl+N`, `Ctrl+,`, `Shift+J`. */
  combo: string
  handler: ShortcutHandler
  /** Optional human description, used by future command-palette UI. */
  description?: string
}

interface ParsedCombo {
  key: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

const bindings = new Map<symbol, ShortcutBinding>()
let attached = false

function parseCombo(combo: string): ParsedCombo {
  const tokens = combo
    .split('+')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  const key = tokens.pop() ?? ''
  return {
    key,
    ctrl: tokens.includes('ctrl') || tokens.includes('control'),
    shift: tokens.includes('shift'),
    alt: tokens.includes('alt') || tokens.includes('option'),
    meta: tokens.includes('meta') || tokens.includes('cmd') || tokens.includes('super')
  }
}

function matches(event: KeyboardEvent, parsed: ParsedCombo): boolean {
  return (
    event.key.toLowerCase() === parsed.key &&
    event.ctrlKey === parsed.ctrl &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    event.metaKey === parsed.meta
  )
}

function dispatch(event: KeyboardEvent) {
  // Latest registration wins, so iterate in reverse insertion order. This lets
  // a modal's local Escape handler take priority over a global one.
  const entries = Array.from(bindings.values()).reverse()
  for (const binding of entries) {
    if (matches(event, parseCombo(binding.combo))) {
      binding.handler(event)
      return
    }
  }
}

function ensureAttached(): void {
  if (attached) return
  if (typeof window === 'undefined') return
  window.addEventListener('keydown', dispatch)
  attached = true
}

export function registerShortcut(binding: ShortcutBinding): () => void {
  ensureAttached()
  const id = Symbol(binding.combo)
  bindings.set(id, binding)
  return () => {
    bindings.delete(id)
  }
}

export function listShortcuts(): ReadonlyArray<ShortcutBinding> {
  return Array.from(bindings.values())
}
