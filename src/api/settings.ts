import { invoke } from '@tauri-apps/api/core'

/**
 * Tauri command bindings for the slice 0008 settings surface.
 *
 * For now the only setting surfaced through dedicated commands is
 * `queue_concurrency_extract` — the user-configurable tier budget for
 * the `JobQueue`'s extract jobs. Other persisted settings (recent
 * projects, tool paths) flow through their dedicated command pairs
 * already (`project_*`, `tool_*`).
 */

/**
 * Read the persisted `queue_concurrency_extract`. Returns the
 * forward-compat default (2) when the settings file predates slice
 * 0008.
 */
export async function settingsGetQueueConcurrency(): Promise<number> {
  return invoke<number>('settings_get_queue_concurrency')
}

/**
 * Persist a new `queue_concurrency_extract` and propagate to the
 * live `JobQueue` so freed extract slots are immediately consumed
 * by newly-dispatched jobs (no restart needed, per AC).
 *
 * The backend clamps to `1..=8` and returns the post-clamp value so
 * the UI can echo the actual stored number even when the input was
 * out of range. Callers should treat the returned number as the
 * authoritative new value.
 */
export async function settingsSetQueueConcurrency(value: number): Promise<number> {
  return invoke<number>('settings_set_queue_concurrency', { value })
}
