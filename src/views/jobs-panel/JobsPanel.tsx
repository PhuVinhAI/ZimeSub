import type { JobKind, JobStatus, JobView } from '@api/jobs'
import ProgressBar from '@design-system/ProgressBar'
import { useModal } from '@lib/modal/modalStack'
import {
  cancelJobById,
  jobsStore,
  removePendingJobById,
  retryJob,
  startExtractSubtitle
} from '@stores/jobs'
import { openProjectByPath, projectsStore } from '@stores/projects'
import { CheckCircle2, RotateCw, Trash2, X, XCircle } from 'lucide-solid'
import { createMemo, For, Show, type Component, type JSX } from 'solid-js'

/**
 * Jobs panel — Rounded Flat refresh.
 *
 * Slide-up bottom sheet anchored above the status bar. The whole
 * sheet is a single rounded surface card; lifecycle buckets are
 * spaced as nested rounded cards instead of being separated by
 * top-borders, keeping the silhouette continuous.
 */
interface JobsPanelProps {
  open: boolean
  onClose: () => void
}

const SECTION_LABELS: Record<JobStatus, string> = {
  pending: 'Đang chờ',
  running: 'Đang chạy',
  done: 'Đã xong',
  failed: 'Lỗi',
  cancelled: 'Đã hủy'
}

const SECTION_ORDER: JobStatus[] = ['running', 'pending', 'failed', 'cancelled', 'done']

const JobsPanel: Component<JobsPanelProps> = props => {
  return (
    <Show when={props.open}>
      <JobsPanelInner onClose={props.onClose} />
    </Show>
  )
}

const JobsPanelInner: Component<{ onClose: () => void }> = props => {
  useModal(() => props.onClose())

  const buckets = createMemo(() => {
    const out: Record<JobStatus, JobView[]> = {
      pending: [],
      running: [],
      done: [],
      failed: [],
      cancelled: []
    }
    for (const job of jobsStore.jobs) {
      out[job.status].push(job)
    }
    return out
  })

  const handleBackdrop = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  return (
    <div
      id="jobs-panel"
      class="fixed inset-0 z-40 flex items-end bg-bg/70 p-3"
      onClick={handleBackdrop}
      role="presentation"
    >
      <section
        class="flex max-h-[70vh] w-full flex-col overflow-hidden rounded-[28px] border border-border bg-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Bảng Jobs"
      >
        <header class="flex items-center justify-between gap-4 px-7 pt-6 pb-2">
          <div class="flex items-center gap-3">
            <h2 class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text uppercase">
              Jobs
            </h2>
            <span class="rounded-full bg-elevated px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-text-muted">
              {jobsStore.jobs.length} TỔNG
            </span>
          </div>
          <button
            type="button"
            onClick={() => props.onClose()}
            class="-mr-2 flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-text-muted transition-colors hover:bg-elevated hover:text-text"
            aria-label="Đóng bảng Jobs"
          >
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div class="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pt-2 pb-5">
          <Show when={jobsStore.jobs.length > 0} fallback={<JobsPanelEmpty />}>
            <For each={SECTION_ORDER}>
              {status => (
                <Show when={buckets()[status].length > 0}>
                  <JobBucket
                    label={SECTION_LABELS[status]}
                    jobs={buckets()[status]}
                    onCloseAfterAction={() => props.onClose()}
                  />
                </Show>
              )}
            </For>
          </Show>
        </div>
      </section>
    </div>
  )
}

interface JobBucketProps {
  label: string
  jobs: JobView[]
  onCloseAfterAction: () => void
}

const JobBucket: Component<JobBucketProps> = props => (
  <section class="rounded-2xl bg-elevated p-3">
    <h3 class="px-3 pb-2 font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
      {props.label} · {props.jobs.length}
    </h3>
    <ul class="flex flex-col gap-1.5">
      <For each={props.jobs}>
        {job => <JobRow job={job} onCloseAfterAction={props.onCloseAfterAction} />}
      </For>
    </ul>
  </section>
)

interface JobRowProps {
  job: JobView
  onCloseAfterAction: () => void
}

const KIND_LABEL: Record<JobKind, string> = {
  extract_subtitle: 'Trích xuất sub',
  extract_audio: 'Trích xuất audio',
  render: 'Render'
}

const STATUS_TONE: Record<JobStatus, string> = {
  pending: 'bg-elevated text-text-muted',
  running: 'bg-accent-soft text-accent',
  done: 'bg-accent-soft text-accent',
  failed: 'bg-danger-soft text-danger',
  cancelled: 'bg-warn-soft text-warn'
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Chờ',
  running: 'Chạy',
  done: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Hủy'
}

const JobRow: Component<JobRowProps> = props => {
  const handleJump = async (): Promise<void> => {
    props.onCloseAfterAction()
    const activeFolder = projectsStore.activeFolder
    if (
      !activeFolder ||
      activeFolder.toLowerCase() !== props.job.project_folder.toLowerCase()
    ) {
      await openProjectByPath(props.job.project_folder)
    }
  }

  const handleCancel = (): void => {
    void cancelJobById(props.job.id)
  }

  const handleRemove = (): void => {
    void removePendingJobById(props.job.id)
  }

  const handleRetry = async (): Promise<void> => {
    props.onCloseAfterAction()
    const activeFolder = projectsStore.activeFolder
    if (
      !activeFolder ||
      activeFolder.toLowerCase() !== props.job.project_folder.toLowerCase()
    ) {
      await openProjectByPath(props.job.project_folder)
    }
    if (props.job.kind === 'extract_subtitle') {
      await startExtractSubtitle(props.job.episode_id)
    } else {
      await retryJob(props.job)
    }
  }

  return (
    <li class="flex items-center gap-4 rounded-xl bg-surface px-4 py-3">
      <div class="flex w-24 flex-none font-mono text-[10px] tracking-wide text-text-muted">
        {formatRelative(props.job.created_at)}
      </div>

      <button
        type="button"
        onClick={() => void handleJump()}
        class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left transition-colors hover:text-accent"
        aria-label={`Mở Episode ${props.job.episode_name}`}
        title="Mở Episode trong project"
      >
        <span class="truncate font-mono text-xs text-text">{props.job.episode_name}</span>
        <span class="truncate font-mono text-[10px] text-text-faint">
          {tailOfPath(props.job.project_folder)}
        </span>
      </button>

      <span class="flex w-32 flex-none font-mono text-[10px] tracking-[0.16em] text-text-faint uppercase">
        {KIND_LABEL[props.job.kind]}
      </span>

      <span
        class={[
          'inline-flex h-7 w-20 flex-none items-center justify-center rounded-full font-mono text-[10px] font-semibold tracking-[0.16em] uppercase',
          STATUS_TONE[props.job.status]
        ].join(' ')}
      >
        {STATUS_LABEL[props.job.status]}
      </span>

      <div class="flex w-32 flex-none items-center justify-end gap-2">
        <Show when={props.job.status === 'running'}>
          <ProgressBar
            ratio={props.job.ratio}
            ariaLabel={`Tiến độ ${KIND_LABEL[props.job.kind]}`}
            ariaValueText={props.job.hint || `${Math.round(props.job.ratio * 100)}%`}
          />
          <span class="w-10 flex-none text-right font-mono text-[10px] text-text-muted">
            {props.job.hint || `${Math.round(props.job.ratio * 100)}%`}
          </span>
        </Show>
        <Show when={props.job.status === 'done'}>
          <CheckCircle2
            size={16}
            strokeWidth={1.5}
            class="ml-auto text-accent"
            aria-hidden="true"
          />
        </Show>
        <Show when={props.job.status === 'failed'}>
          <XCircle
            size={16}
            strokeWidth={1.5}
            class="ml-auto text-danger"
            aria-hidden="true"
          />
        </Show>
      </div>

      <div class="flex w-28 flex-none items-center justify-end">
        <Show when={props.job.status === 'running'}>
          <ActionButton
            label="Hủy"
            onClick={handleCancel}
            tone="danger"
            ariaLabel="Hủy job đang chạy"
            icon={<X size={12} strokeWidth={1.5} aria-hidden="true" />}
          />
        </Show>
        <Show when={props.job.status === 'pending'}>
          <ActionButton
            label="Xóa"
            onClick={handleRemove}
            tone="neutral"
            ariaLabel="Xóa job chờ"
            icon={<Trash2 size={12} strokeWidth={1.5} aria-hidden="true" />}
          />
        </Show>
        <Show when={props.job.status === 'failed' || props.job.status === 'cancelled'}>
          <ActionButton
            label="Thử lại"
            onClick={() => void handleRetry()}
            tone="accent"
            ariaLabel="Thử lại job"
            icon={<RotateCw size={12} strokeWidth={1.5} aria-hidden="true" />}
          />
        </Show>
      </div>
    </li>
  )
}

interface ActionButtonProps {
  label: string
  onClick: () => void
  tone: 'accent' | 'danger' | 'neutral'
  ariaLabel: string
  icon: JSX.Element
}

const TONE_CLASSES: Record<ActionButtonProps['tone'], string> = {
  accent: 'bg-accent-soft text-accent hover:bg-accent hover:text-accent-on-accent',
  danger: 'bg-danger-soft text-danger hover:bg-danger hover:text-bg',
  neutral: 'bg-elevated text-text-muted hover:bg-surface hover:text-accent'
}

const ActionButton: Component<ActionButtonProps> = props => (
  <button
    type="button"
    onClick={() => props.onClick()}
    class={[
      'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 font-mono text-[10px] font-semibold tracking-[0.16em] uppercase transition-colors',
      TONE_CLASSES[props.tone]
    ].join(' ')}
    aria-label={props.ariaLabel}
  >
    {props.icon}
    <span>{props.label}</span>
  </button>
)

const JobsPanelEmpty: Component = () => (
  <div
    class="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-2xl bg-elevated px-6 py-12 text-center"
    aria-label="Hàng đợi trống"
  >
    <p class="text-base text-text">Chưa có job nào</p>
    <p class="font-mono text-[11px] text-text-muted">
      Job sẽ xuất hiện ở đây khi bạn bắt đầu trích xuất hoặc render.
    </p>
  </div>
)

function formatRelative(epochMs: number): string {
  const deltaMs = Date.now() - epochMs
  if (deltaMs < 0) return 'vừa rồi'
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds} giây trước`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} phút trước`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} giờ trước`
  const days = Math.floor(hours / 24)
  return `${days} ngày trước`
}

function tailOfPath(p: string): string {
  const normalised = p.replace(/[\\/]+$/, '')
  const idx = Math.max(normalised.lastIndexOf('\\'), normalised.lastIndexOf('/'))
  return idx >= 0 ? normalised.slice(idx + 1) : normalised
}

export default JobsPanel
