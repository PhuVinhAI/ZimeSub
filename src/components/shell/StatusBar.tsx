import type { JobKind, JobView } from '@api/jobs'
import ProgressBar from '@design-system/ProgressBar'
import { jobsStore, queueSummary, topRunningJob } from '@stores/jobs'
import { ChevronUp, Loader2, Settings } from 'lucide-solid'
import { For, Match, Show, Switch, type Component } from 'solid-js'

/**
 * Bottom status bar (slice 0008, full version).
 *
 * Always 56 px tall per docs/style-guide.md. Layout from left to
 * right:
 *  - `JOBS ●●○○○` indicator — filled dots count active jobs, capped
 *    at the user's `queue_concurrency_extract + 1` (the Render
 *    tier). Five-dot baseline so the visual rhythm holds when the
 *    queue is empty too.
 *  - `X / Y` running / total counter.
 *  - Current top-job display (episode label + JobKind tag) with a
 *    live progress bar driven by the parsed % ratio.
 *  - Settings gear on the far right.
 *  - The whole left cluster is a click target that toggles the
 *    Jobs panel; clicking the gear stops propagation so it doesn't
 *    double-fire.
 *
 * Empty queue: falls back to the slice-0001 placeholder copy
 * ("chưa có job nào") so the layout never shifts based on history
 * state — only on whether work is currently in flight.
 */
interface StatusBarProps {
  onOpenSettings: () => void
  onToggleJobsPanel: () => void
  /** Mirrors the panel's open/closed state for the chevron + ARIA. */
  jobsPanelOpen: boolean
}

const STATUS_BAR_DOT_COUNT = 5

const StatusBar: Component<StatusBarProps> = props => {
  const summary = (): { pending: number; running: number; total: number } =>
    queueSummary()
  const top = (): JobView | null => topRunningJob()
  const hasJobs = (): boolean => summary().total > 0

  return (
    <footer
      class="flex h-14 flex-none items-center justify-between gap-4 border-t-2 border-border bg-surface px-6"
      aria-label="Trạng thái hàng đợi"
    >
      <button
        type="button"
        onClick={() => props.onToggleJobsPanel()}
        class="flex min-w-0 flex-1 items-center gap-4 text-left transition-colors hover:text-text"
        aria-expanded={props.jobsPanelOpen}
        aria-controls="jobs-panel"
        aria-label="Mở bảng Jobs"
      >
        <DotIndicator running={summary().running} />

        <span class="font-mono text-xs text-text-muted">
          <span class="text-text">{summary().running}</span>
          <span class="px-1">/</span>
          <span>{summary().total}</span>
        </span>

        <Switch
          fallback={
            <span class="font-mono text-sm text-text-muted">chưa có job nào</span>
          }
        >
          <Match when={hasJobs() && top()}>
            {jobAccessor => <TopJobSlot job={jobAccessor()} />}
          </Match>
        </Switch>

        <ChevronUp
          size={16}
          strokeWidth={1.5}
          class={[
            'ml-auto flex-none text-text-muted transition-transform',
            props.jobsPanelOpen ? 'rotate-180' : 'rotate-0'
          ].join(' ')}
          aria-hidden="true"
        />
      </button>

      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          props.onOpenSettings()
        }}
        class="flex h-9 w-9 flex-none items-center justify-center border-2 border-transparent text-text-muted transition-colors hover:border-border hover:text-text"
        aria-label="Mở cài đặt"
        title="Cài đặt"
      >
        <Settings size={18} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </footer>
  )
}

interface DotIndicatorProps {
  running: number
}

/**
 * `JOBS ●●○○○` indicator. Filled dots count the *running* jobs
 * (regardless of tier — Render and Extract both count). Five dots
 * baseline matches the style-guide mock; if the running count
 * exceeds the dot count (e.g. user cranked concurrency to 8), the
 * extra count is conveyed by the trailing "X / Y" counter so the
 * visual width of the indicator stays stable.
 */
const DotIndicator: Component<DotIndicatorProps> = props => {
  const dots = (): boolean[] => {
    const filled = Math.min(props.running, STATUS_BAR_DOT_COUNT)
    return Array.from({ length: STATUS_BAR_DOT_COUNT }, (_, i) => i < filled)
  }
  return (
    <div class="flex flex-none items-center gap-2">
      <span class="font-mono text-xs font-semibold tracking-[0.18em] text-text">
        JOBS
      </span>
      <span class="flex items-center gap-1" aria-hidden="true">
        <For each={dots()}>
          {filled => (
            <span
              class={[
                'inline-block h-2 w-2 border-2',
                filled ? 'border-accent bg-accent' : 'border-border bg-bg'
              ].join(' ')}
            />
          )}
        </For>
      </span>
      <span class="sr-only">
        {props.running} job đang chạy trong tổng số {jobsStore.jobs.length}
      </span>
    </div>
  )
}

interface TopJobSlotProps {
  job: JobView
}

const JOB_KIND_LABEL: Record<JobKind, string> = {
  extract_subtitle: 'Trích xuất sub',
  extract_audio: 'Trích xuất audio',
  render: 'Render'
}

/**
 * Top-of-list job display in the centre of the status bar. Renders
 * the episode name (truncated) + the JobKind label + the live
 * progress bar (using the parsed % ratio when available).
 */
const TopJobSlot: Component<TopJobSlotProps> = props => {
  const percentLabel = (): string => {
    if (props.job.hint) return props.job.hint
    return `${Math.round(props.job.ratio * 100)}%`
  }
  const isRunning = (): boolean => props.job.status === 'running'

  return (
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <Show when={isRunning()}>
        <Loader2
          size={14}
          strokeWidth={1.5}
          class="flex-none animate-spin text-accent"
          aria-hidden="true"
        />
      </Show>
      <span class="truncate font-mono text-xs text-text" title={props.job.episode_name}>
        {props.job.episode_name}
      </span>
      <span class="flex-none font-mono text-xs uppercase tracking-wide text-text-muted">
        {JOB_KIND_LABEL[props.job.kind]}
      </span>
      <Show when={isRunning() || props.job.ratio > 0}>
        <div class="flex min-w-[140px] flex-1 items-center gap-2">
          <ProgressBar
            ratio={props.job.ratio}
            ariaLabel={`Tiến độ ${JOB_KIND_LABEL[props.job.kind]}`}
            ariaValueText={percentLabel()}
          />
          <span class="w-12 flex-none text-right font-mono text-xs text-text-muted">
            {percentLabel()}
          </span>
        </div>
      </Show>
      <Show when={!isRunning() && props.job.status === 'pending'}>
        <span class="font-mono text-xs text-text-muted">Đang chờ</span>
      </Show>
    </div>
  )
}

export default StatusBar
