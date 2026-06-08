import type { JobKind, JobView } from '@api/jobs'
import ProgressBar from '@design-system/ProgressBar'
import { jobsStore, queueSummary, topRunningJob } from '@stores/jobs'
import { ChevronUp, Loader2, Settings } from 'lucide-solid'
import { For, Match, Show, Switch, type Component } from 'solid-js'

/**
 * Bottom status bar — Rounded Flat refresh.
 *
 * Sits in the shell's inset rail as a rounded pill card (no edge-to-
 * edge `border-t`). Left cluster: queue indicator + dot row + counter;
 * centre: live top-job slot with the progress bar; right: settings
 * gear button. The whole left cluster is the Jobs-panel toggle so
 * the user can dive in with one click.
 *
 * Empty queue: falls back to the placeholder copy ("chưa có job nào")
 * so the layout only shifts based on whether work is currently in
 * flight, not on history.
 */
interface StatusBarProps {
  onOpenSettings: () => void
  onToggleJobsPanel: () => void
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
      class="flex h-16 flex-none items-center justify-between gap-4 rounded-[28px] border border-border bg-surface px-5"
      aria-label="Trạng thái hàng đợi"
    >
      <button
        type="button"
        onClick={() => props.onToggleJobsPanel()}
        class="flex min-w-0 flex-1 items-center gap-4 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-elevated"
        aria-expanded={props.jobsPanelOpen}
        aria-controls="jobs-panel"
        aria-label="Mở bảng Jobs"
      >
        <DotIndicator running={summary().running} />

        <span class="font-mono text-xs text-text-muted">
          <span class="text-text">{summary().running}</span>
          <span class="px-1 text-text-faint">/</span>
          <span>{summary().total}</span>
        </span>

        <Switch
          fallback={
            <span class="font-mono text-xs tracking-wide text-text-muted">
              chưa có job nào
            </span>
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
        class="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-border bg-elevated text-text-muted transition-colors hover:border-accent hover:text-accent"
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

const DotIndicator: Component<DotIndicatorProps> = props => {
  const dots = (): boolean[] => {
    const filled = Math.min(props.running, STATUS_BAR_DOT_COUNT)
    return Array.from({ length: STATUS_BAR_DOT_COUNT }, (_, i) => i < filled)
  }
  return (
    <div class="flex flex-none items-center gap-2.5">
      <span class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-faint uppercase">
        Jobs
      </span>
      <span class="flex items-center gap-1.5" aria-hidden="true">
        <For each={dots()}>
          {filled => (
            <span
              class={[
                'inline-block h-2 w-2 rounded-full',
                filled ? 'bg-accent' : 'bg-border'
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
      <span class="flex-none font-mono text-[10px] tracking-[0.16em] text-text-faint uppercase">
        {JOB_KIND_LABEL[props.job.kind]}
      </span>
      <Show when={isRunning() || props.job.ratio > 0}>
        <div class="flex min-w-[140px] flex-1 items-center gap-2">
          <ProgressBar
            ratio={props.job.ratio}
            ariaLabel={`Tiến độ ${JOB_KIND_LABEL[props.job.kind]}`}
            ariaValueText={percentLabel()}
          />
          <span class="w-12 flex-none text-right font-mono text-[11px] text-text-muted">
            {percentLabel()}
          </span>
        </div>
      </Show>
      <Show when={!isRunning() && props.job.status === 'pending'}>
        <span class="font-mono text-[11px] text-text-muted">Đang chờ</span>
      </Show>
    </div>
  )
}

export default StatusBar
