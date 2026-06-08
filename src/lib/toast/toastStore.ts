import { createStore, produce } from 'solid-js/store'

/**
 * Lightweight transient-message store for the top-right toast stack.
 *
 * The same three tones as `StatusBadge` map to the docs/style-guide.md
 * tokens — `danger` for hard errors, `warn` for non-blocking attention,
 * `accent` for success / neutral confirmations. Toasts auto-dismiss
 * after `durationMs` (default 4 s) so users with a stack of warnings
 * (e.g. dropping 12 files where 6 are non-MKV) don't have to manually
 * close each one. A manual close affordance is still provided on the
 * card for users who want to clear them sooner.
 *
 * The store lives at module level — there is exactly one global toast
 * stack and any component can push without prop-drilling.
 */
export type ToastTone = 'accent' | 'warn' | 'danger'

export interface ToastEntry {
  id: number
  tone: ToastTone
  message: string
}

interface ToastStoreShape {
  entries: ToastEntry[]
}

const [state, setState] = createStore<ToastStoreShape>({ entries: [] })

export const toastStore = state

let nextId = 0

const DEFAULT_DURATION_MS = 4000

/**
 * Push a new toast onto the stack. Returns the assigned id so callers
 * can manually `dismissToast(id)` early — useful when the trigger
 * resolves before the auto-dismiss fires.
 *
 * `durationMs <= 0` keeps the toast on screen until the user dismisses
 * it or another `dismissToast` call removes it.
 */
export function pushToast(
  tone: ToastTone,
  message: string,
  durationMs: number = DEFAULT_DURATION_MS
): number {
  nextId += 1
  const id = nextId
  setState(
    produce(s => {
      s.entries.push({ id, tone, message })
    })
  )
  if (durationMs > 0) {
    setTimeout(() => dismissToast(id), durationMs)
  }
  return id
}

/** Convenience wrappers — read better at call sites than `pushToast('danger', …)`. */
export const pushDangerToast = (message: string): number => pushToast('danger', message)
export const pushWarnToast = (message: string): number => pushToast('warn', message)
export const pushAccentToast = (message: string): number => pushToast('accent', message)

/**
 * Drop a single toast by id. Idempotent — a stale id (already auto-
 * dismissed, or never pushed) is a no-op.
 */
export function dismissToast(id: number): void {
  setState(
    produce(s => {
      const idx = s.entries.findIndex(e => e.id === id)
      if (idx >= 0) s.entries.splice(idx, 1)
    })
  )
}

/** Drop every visible toast — used by tests and future "clear all" UI. */
export function clearToasts(): void {
  setState({ entries: [] })
}
