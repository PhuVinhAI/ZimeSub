import { toolProbe, toolRescan, type ToolReport } from '@api/tooling'
import { createStore } from 'solid-js/store'

/**
 * Holds the RequiredTool detection state used by `AppShell` to decide
 * whether to render the Onboarding gate, and by `views/onboarding` to draw
 * the per-tool rows.
 *
 * Lifecycle:
 *  - `initial`: AppShell has not run the first probe yet; show a brief
 *    "Đang kiểm tra môi trường..." overlay so the user never sees the
 *    Onboarding panel flicker before real data arrives.
 *  - `ready`: probe finished. Component decides Onboarding vs main shell
 *    based on `allReady()`.
 *  - `rescanning`: user hit "Quét lại" — keep showing the last reports
 *    while re-probing so the panel doesn't blank out.
 *  - `error`: command threw; show the error and let the user retry.
 */
export type ToolsPhase = 'initial' | 'ready' | 'rescanning' | 'error'

interface ToolsStoreShape {
  phase: ToolsPhase
  reports: ToolReport[]
  error: string | null
}

const [state, setState] = createStore<ToolsStoreShape>({
  phase: 'initial',
  reports: [],
  error: null
})

export const toolsStore = state

export const allReady = (): boolean =>
  state.reports.length === 3 && state.reports.every(r => r.status === 'Ready')

/**
 * Run the initial probe. Safe to call once on `AppShell.onMount`. If a
 * probe is already in flight or the phase has already moved past
 * `initial`, this is a no-op so React-strict-mode-style double mounts
 * never trigger a double-probe.
 */
export async function bootstrapTools(): Promise<void> {
  if (state.phase !== 'initial') return
  try {
    const reports = await toolProbe()
    setState({ phase: 'ready', reports, error: null })
  } catch (err) {
    setState({
      phase: 'error',
      reports: [],
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Force a re-detect ignoring cached entries. Drives the Onboarding
 * "Quét lại" button.
 */
export async function rescanTools(): Promise<void> {
  setState({ phase: 'rescanning', error: null })
  try {
    const reports = await toolRescan()
    setState({ phase: 'ready', reports })
  } catch (err) {
    setState({
      phase: 'error',
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
