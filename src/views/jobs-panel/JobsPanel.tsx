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
 * Slice 0008 Jobs panel.
 *
 * Renders the four lifecycle buckets — pending / running / done /
 * failed — as flat sections inside a slide-up overlay that sits
 * above the bottom status bar. Each row carries:
 *  - Relative timestamp (e.g. "2 phút trước")
 *  - Episode name (click to jump to that Episode in its Project)
 *  - JobKind label
 *  - JobStatus pill
 *  - Progress % (live for Running rows; final % for terminal rows)
 *  - Action button: Cancel (Running), Remove (Pending), Retry (Failed)
 *
 * Done + Cancelled rows have no action button per AC (cancelled
 * still surfaces a retry option mirroring failed, since both
 * leave the artefact missing). The terminal "Done" rows persist
 * for the lifetime of the app session.
 *
 * Cancelled rows are listed under "Đã hủy" alongside Done so the
 * lifecycle terminal state is visible in two places (panel summary
 * + the row's status pill).
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
      class="fixed inset-0 z-40 flex items-end bg-bg/70"
      onClick={handleBackdrop}
      role="presentation"
    >
      <section
        class="flex max-h-[70vh] w-full flex-col border-t-2 border-border bg-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Bảng Jobs"
      >
        <header class="flex items-center justify-between gap-4 border-b-2 border-border px-6 py-4">
          <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text">
            JOBS · {jobsStore.jobs.length}
          </h2>
          <button
            type="button"
            onClick={() => props.onClose()}
            class="-mr-2 flex h-9 w-9 items-center justify-center border-2 border-transparent text-text-muted transition-colors hover:border-border hover:text-text"
            aria-label="Đóng bảng Jobs"
          >
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div class="flex-1 overflow-y-auto">
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
  <section class="border-b-2 border-border last:border-b-0">
    <h3 class="px-6 py-3 font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
      {props.label.toUpperCase()} · {props.jobs.length}
    </h3>
    <ul class="flex flex-col">
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
  pending: 'border-text-muted text-text-muted',
  running: 'border-accent text-accent',
  done: 'border-accent text-accent',
  failed: 'border-danger text-danger',
  cancelled: 'border-warn text-warn'
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Chờ',
  running: 'Đang chạy',
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
    // Retry for ExtractSubtitle re-enqueues for the same Episode in
    // the same project. For now this is the only retryable kind
    // (audio + render retries land with their owning slices).
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
    <li class="flex items-center gap-4 border-t-2 border-border px-6 py-3 first:border-t-0">
      <div class="flex w-24 flex-none font-mono text-xs text-text-muted">
        {formatRelative(props.job.created_at)}
      </div>

      <button
        type="button"
        onClick={() => void handleJump()}
        class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left transition-colors hover:text-accent"
        aria-label={`Mở Episode ${props.job.episode_name}`}
        title="Mở Episode trong project"
      >
        <span class="truncate font-mono text-sm text-text">{props.job.episode_name}</span>
        <span class="truncate font-mono text-xs text-text-muted">
          {tailOfPath(props.job.project_folder)}
        </span>
      </button>

      <span class="flex w-32 flex-none font-mono text-xs uppercase tracking-wide text-text-muted">
        {KIND_LABEL[props.job.kind]}
      </span>

      <span
        class={[
          'inline-flex h-6 w-24 flex-none items-center justify-center border-2 bg-bg px-2 font-mono text-xs font-medium tracking-wide uppercase',
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
          <span class="w-10 flex-none text-right font-mono text-xs text-text-muted">
            {props.job.hint || `${Math.round(props.job.ratio * 100)}%`}
          </span>
        </Show>
        <Show when={props.job.status === 'done' || props.job.status === 'failed'}>
          <span class="w-10 flex-none text-right font-mono text-xs text-text-muted">
            {props.job.status === 'done' ? (
              <CheckCircle2
                size={16}
                strokeWidth={1.5}
                class="ml-auto text-accent"
                aria-hidden="true"
              />
            ) : (
              <XCircle
                size={16}
                strokeWidth={1.5}
                class="ml-auto text-danger"
                aria-hidden="true"
              />
            )}
          </span>
        </Show>
      </div>

      <div class="flex w-28 flex-none items-center justify-end">
        <Show when={props.job.status === 'running'}>
          <ActionButton
            label="Hủy"
            onClick={handleCancel}
            tone="danger"
            ariaLabel="Hủy job đang chạy"
            icon={<X size={14} strokeWidth={1.5} aria-hidden="true" />}
          />
        </Show>
        <Show when={props.job.status === 'pending'}>
          <ActionButton
            label="Xóa"
            onClick={handleRemove}
            tone="neutral"
            ariaLabel="Xóa job chờ"
            icon={<Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />}
          />
        </Show>
        <Show when={props.job.status === 'failed' || props.job.status === 'cancelled'}>
          <ActionButton
            label="Thử lại"
            onClick={() => void handleRetry()}
            tone="accent"
            ariaLabel="Thử lại job"
            icon={<RotateCw size={14} strokeWidth={1.5} aria-hidden="true" />}
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
  accent: 'border-accent text-accent hover:bg-accent hover:text-accent-on-accent',
  danger: 'border-danger text-danger hover:bg-danger hover:text-accent-on-accent',
  neutral: 'border-border text-text-muted hover:border-accent hover:text-accent'
}

const ActionButton: Component<ActionButtonProps> = props => (
  <button
    type="button"
    onClick={() => props.onClick()}
    class={[
      'inline-flex h-8 items-center justify-center gap-1.5 border-2 bg-bg px-3 font-mono text-xs font-medium tracking-wide uppercase transition-colors',
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
    class="flex min-h-[200px] flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    aria-label="Hàng đợi trống"
  >
    <p class="text-base text-text">Chưa có job nào</p>
    <p class="font-mono text-xs text-text-muted">
      Job sẽ xuất hiện ở đây khi bạn bắt đầu trích xuất hoặc render.
    </p>
  </div>
)

/**
 * Vietnamese relative-time label for `created_at` (unix ms). Keeps
 * the panel rows compact — full timestamps are only useful when
 * forensics-debugging from the app log, not from the UI.
 */
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
