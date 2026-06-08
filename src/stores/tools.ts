import {
  onInstallDone,
  onInstallLog,
  toolInstallCancel,
  toolInstallStart,
  wingetAvailable,
  type InstallDoneEvent,
  type InstallLogEvent
} from '@api/install'
import { toolProbe, toolRescan, type ToolName, type ToolReport } from '@api/tooling'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { createStore, produce } from 'solid-js/store'

/**
 * Holds the RequiredTool detection state, plus the live winget install
 * state, used by `AppShell` to decide whether to render the Onboarding gate
 * and by `views/onboarding` to draw rows + the terminal log panel.
 *
 * Lifecycle of `phase`:
 *  - `initial`:    AppShell has not run the first probe yet.
 *  - `ready`:      probe finished — Onboarding vs main shell decided by `allReady()`.
 *  - `rescanning`: user (or post-install auto-trigger) is re-probing.
 *  - `error`:      probe command threw.
 *
 * Lifecycle of `install.phase`:
 *  - `idle`:    no install has run this session, or the previous logs were cleared.
 *  - `running`: winget child process is alive.
 *  - `success`: winget exited 0.
 *  - `failed`:  winget exited non-zero, or the supervisor reported an error.
 *  - `cancelled`: user clicked Hủy.
 */
export type ToolsPhase = 'initial' | 'ready' | 'rescanning' | 'error'

export type InstallPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

export interface InstallLogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

interface InstallState {
  phase: InstallPhase
  installId: string | null
  tool: ToolName | null
  logs: InstallLogLine[]
  exitCode: number | null
  error: string | null
}

interface ToolsStoreShape {
  phase: ToolsPhase
  reports: ToolReport[]
  error: string | null
  wingetAvailable: boolean | null
  install: InstallState
}

const initialInstall: InstallState = {
  phase: 'idle',
  installId: null,
  tool: null,
  logs: [],
  exitCode: null,
  error: null
}

const [state, setState] = createStore<ToolsStoreShape>({
  phase: 'initial',
  reports: [],
  error: null,
  wingetAvailable: null,
  install: { ...initialInstall, logs: [] }
})

export const toolsStore = state

export const allReady = (): boolean =>
  state.reports.length === 3 && state.reports.every(r => r.status === 'Ready')

/**
 * Two tools share the same winget package (MKVToolNix.MKVToolNix delivers
 * both mkvmerge and mkvextract). When an install is in flight for one, the
 * sibling tool's UI should reflect that — same disabled install button,
 * same "Đang cài..." badge.
 */
const sharedPackageSiblings: Record<ToolName, ToolName[]> = {
  mkvmerge: ['mkvextract'],
  mkvextract: ['mkvmerge'],
  ffmpeg: []
}

export function isInstallingTool(tool: ToolName): boolean {
  if (state.install.phase !== 'running') return false
  const active = state.install.tool
  if (!active) return false
  if (active === tool) return true
  return sharedPackageSiblings[active].includes(tool)
}

/**
 * Last completed install targeted this tool (or its sibling). Used by the
 * UI to scope the "Thử lại" affordance to the right row.
 */
export function isLastInstallForTool(tool: ToolName): boolean {
  const installed = state.install.tool
  if (!installed) return false
  if (installed === tool) return true
  return sharedPackageSiblings[installed].includes(tool)
}

/**
 * Run the initial probe + bind the install event subscriptions. Safe to
 * call once on `AppShell.onMount`. If a probe is already in flight or the
 * phase has already moved past `initial`, the probe step is a no-op so
 * Solid's double-mount-in-dev never triggers a double-probe; the
 * subscriptions are guarded by a module-level flag and likewise idempotent.
 */
export async function bootstrapTools(): Promise<void> {
  await ensureInstallSubscriptions()
  await ensureWingetAvailability()
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
 * "Quét lại" button and the post-install auto-rescan.
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

/**
 * Start a winget install for `tool`. Generates a fresh `install_id`,
 * resets the log buffer, and dispatches the backend command. Returns
 * after the command resolves (i.e. winget has been spawned, not after it
 * exits) — completion arrives via the `done` event handler installed in
 * {@link ensureInstallSubscriptions}.
 */
export async function startInstall(tool: ToolName): Promise<void> {
  if (state.install.phase === 'running') return

  const installId = newInstallId()
  setState('install', {
    phase: 'running',
    installId,
    tool,
    logs: [],
    exitCode: null,
    error: null
  })

  try {
    await toolInstallStart(installId, tool)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setState('install', prev => ({
      ...prev,
      phase: 'failed',
      error: message
    }))
  }
}

/**
 * Cancel the in-flight install (no-op if none). The backend kills the
 * winget child and emits a `done` event with `cancelled: true`.
 */
export async function cancelInstall(): Promise<void> {
  const id = state.install.installId
  if (!id || state.install.phase !== 'running') return
  try {
    await toolInstallCancel(id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setState('install', 'error', message)
  }
}

/**
 * Reset the install panel back to `idle`. Wired to the "Đóng nhật ký"
 * button shown after a finished install — clears the terminal log so the
 * panel collapses.
 */
export function clearInstallState(): void {
  setState('install', { ...initialInstall, logs: [] })
}

/**
 * Manual "Tôi đã cài" re-probe entry point — same as {@link rescanTools}
 * but rendered next to the "Mở trang tải" button in the winget-unavailable
 * fallback so the call site is self-documenting.
 */
export async function manualReprobe(): Promise<void> {
  await rescanTools()
}

let installSubscriptionsHandle: { unlistenLog: UnlistenFn; unlistenDone: UnlistenFn } | null =
  null
let installSubscriptionsPromise: Promise<void> | null = null

async function ensureInstallSubscriptions(): Promise<void> {
  if (installSubscriptionsHandle) return
  if (installSubscriptionsPromise) return installSubscriptionsPromise

  installSubscriptionsPromise = (async () => {
    const unlistenLog = await onInstallLog(handleLog)
    const unlistenDone = await onInstallDone(handleDone)
    installSubscriptionsHandle = { unlistenLog, unlistenDone }
  })()

  return installSubscriptionsPromise
}

async function ensureWingetAvailability(): Promise<void> {
  if (state.wingetAvailable !== null) return
  try {
    const available = await wingetAvailable()
    setState('wingetAvailable', available)
  } catch {
    setState('wingetAvailable', false)
  }
}

function handleLog(event: InstallLogEvent): void {
  if (!state.install.installId || event.install_id !== state.install.installId) return
  setState(
    'install',
    'logs',
    produce(lines => {
      lines.push({ stream: event.stream, text: event.line })
    })
  )
}

function handleDone(event: InstallDoneEvent): void {
  if (!state.install.installId || event.install_id !== state.install.installId) return

  const phase: InstallPhase = event.cancelled
    ? 'cancelled'
    : event.success
      ? 'success'
      : 'failed'

  setState('install', prev => ({
    ...prev,
    phase,
    exitCode: event.exit_code,
    error: event.error
  }))

  // ToolProbe is re-run regardless of outcome — winget may have partially
  // installed something useful even when it ultimately fails. The acceptance
  // criteria require an automatic re-probe + badge update.
  void rescanTools()
}

function newInstallId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
