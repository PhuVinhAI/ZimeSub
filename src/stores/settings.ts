import { settingsGetQueueConcurrency, settingsSetQueueConcurrency } from '@api/settings'
import { pushDangerToast } from '@lib/toast/toastStore'
import { createStore } from 'solid-js/store'

/**
 * Holds the live mirror of the user-configurable app settings the
 * post-Onboarding shell needs. Slice 0008 only models
 * `queue_concurrency_extract`; future slices (render defaults, UI
 * preferences) layer in additional fields here.
 *
 * The store is autonomous and does not depend on the projects or
 * jobs stores. `bootstrapSettings()` runs once on AppShell mount to
 * fetch the persisted values; subsequent setter calls round-trip
 * through the backend (which both persists to `settings.json` and
 * propagates to the live `JobQueue`) and then update the local
 * mirror with the post-clamp value.
 */

/** Hard upper bound on the extract concurrency (mirrors backend). */
export const MAX_EXTRACT_CONCURRENCY = 8
/** Hard lower bound on the extract concurrency. */
export const MIN_EXTRACT_CONCURRENCY = 1
/** Backend default — also the forward-compat value for legacy settings.json. */
export const DEFAULT_EXTRACT_CONCURRENCY = 2

interface SettingsStoreShape {
  queueConcurrencyExtract: number
  /** `true` after the first successful `settingsGetQueueConcurrency` call. */
  loaded: boolean
}

const [state, setState] = createStore<SettingsStoreShape>({
  queueConcurrencyExtract: DEFAULT_EXTRACT_CONCURRENCY,
  loaded: false
})

export const settingsStore = state

/**
 * One-shot bootstrap — fetches the persisted concurrency value from
 * the backend. Safe to call multiple times; later calls no-op once
 * `loaded` flips to `true`.
 *
 * Surfaces a Vietnamese danger toast on failure so the user knows
 * the value shown in Settings might be the default rather than
 * their stored value.
 */
export async function bootstrapSettings(): Promise<void> {
  if (state.loaded) return
  try {
    const value = await settingsGetQueueConcurrency()
    setState({ queueConcurrencyExtract: value, loaded: true })
  } catch (err) {
    setState({ loaded: true })
    pushDangerToast(`Không đọc được cài đặt: ${messageOf(err)}`)
  }
}

/**
 * Update the extract concurrency. The backend clamps to `1..=8` and
 * persists; the returned post-clamp value is what we mirror locally.
 * Caller receives the same clamped value so input controls can echo
 * the real stored number.
 */
export async function setQueueConcurrencyExtract(value: number): Promise<number> {
  try {
    const clamped = await settingsSetQueueConcurrency(value)
    setState({ queueConcurrencyExtract: clamped })
    return clamped
  } catch (err) {
    pushDangerToast(`Không lưu được cài đặt: ${messageOf(err)}`)
    return state.queueConcurrencyExtract
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
