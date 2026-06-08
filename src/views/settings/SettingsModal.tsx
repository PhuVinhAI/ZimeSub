import type { ToolReport, ToolStatus } from '@api/tooling'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import StatusBadge, { type BadgeTone } from '@design-system/StatusBadge'
import {
  MAX_EXTRACT_CONCURRENCY,
  MIN_EXTRACT_CONCURRENCY,
  setQueueConcurrencyExtract,
  settingsStore
} from '@stores/settings'
import { rescanTools, toolsStore } from '@stores/tools'
import { Minus, Plus, RefreshCw } from 'lucide-solid'
import { createEffect, createSignal, For, Show, type Component } from 'solid-js'

/**
 * Settings modal — reachable after Onboarding closes via the gear
 * icon in the bottom status bar. Slice 0003 surfaced "Quét lại"
 * + a read-only tool report list; slice 0008 adds a numeric input
 * for `queue_concurrency_extract` (1–8) so the user can tune the
 * tier budget for the JobQueue's extract jobs. Future slices
 * (default render config, UI preferences) layer in on top.
 */
interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const tone: Record<ToolStatus, BadgeTone> = {
  Ready: 'accent',
  Outdated: 'warn',
  Missing: 'danger'
}

const badgeLabel: Record<ToolStatus, string> = {
  Ready: 'Sẵn sàng',
  Outdated: 'Cần cập nhật',
  Missing: 'Chưa cài'
}

const SettingsModal: Component<SettingsModalProps> = props => {
  const handleRescan = (): void => {
    void rescanTools()
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Cài đặt"
      ariaLabel="Cài đặt ứng dụng"
      footer={
        <Button variant="secondary" onClick={() => props.onClose()} aria-label="Đóng">
          <span>Đóng</span>
        </Button>
      }
    >
      <div class="flex flex-col gap-8">
        <section class="flex flex-col gap-5" aria-label="Trạng thái công cụ">
          <div class="flex items-center justify-between gap-4">
            <h3 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
              CÔNG CỤ ĐÃ DÒ
            </h3>
            <Button
              variant="primary"
              onClick={handleRescan}
              disabled={toolsStore.phase === 'rescanning'}
              aria-label="Quét lại công cụ"
            >
              <RefreshCw
                size={18}
                strokeWidth={1.5}
                aria-hidden="true"
                class={toolsStore.phase === 'rescanning' ? 'animate-spin' : ''}
              />
              <span>
                {toolsStore.phase === 'rescanning' ? 'Đang quét...' : 'Quét lại'}
              </span>
            </Button>
          </div>

          <div class="border-2 border-border bg-bg">
            <For each={toolsStore.reports}>
              {report => <SettingsToolRow report={report} />}
            </For>
            <Show when={toolsStore.reports.length === 0}>
              <p class="px-4 py-3 text-sm text-text-muted">Chưa có kết quả dò công cụ.</p>
            </Show>
          </div>

          <p class="text-xs text-text-muted">
            Nhấn <span class="font-mono text-text">Quét lại</span> sau khi bạn vừa cài
            hoặc nâng cấp công cụ bên ngoài app.
          </p>
        </section>

        <section class="flex flex-col gap-4" aria-label="Cấu hình hàng đợi">
          <h3 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            HÀNG ĐỢI
          </h3>
          <QueueConcurrencyField />
        </section>
      </div>
    </Modal>
  )
}

/**
 * Numeric input + nudge buttons for `queue_concurrency_extract`.
 * Local state mirrors the store value so the user can type freely
 * before committing on blur / +/− click. Out-of-range values are
 * silently clamped by the backend; the local state reflects the
 * post-clamp value the backend returns.
 */
const QueueConcurrencyField: Component = () => {
  const [draft, setDraft] = createSignal(settingsStore.queueConcurrencyExtract)
  const [pending, setPending] = createSignal(false)

  // Sync local draft whenever the persisted value changes (e.g. on
  // initial bootstrap or external mutation).
  createEffect(() => {
    setDraft(settingsStore.queueConcurrencyExtract)
  })

  const commit = async (value: number): Promise<void> => {
    if (pending()) return
    setPending(true)
    const clamped = Math.max(
      MIN_EXTRACT_CONCURRENCY,
      Math.min(MAX_EXTRACT_CONCURRENCY, Math.round(value))
    )
    setDraft(clamped)
    try {
      const stored = await setQueueConcurrencyExtract(clamped)
      setDraft(stored)
    } finally {
      setPending(false)
    }
  }

  const handleStep = (delta: number): void => {
    void commit(draft() + delta)
  }

  const handleInput = (event: InputEvent): void => {
    const target = event.currentTarget as HTMLInputElement
    const next = Number.parseInt(target.value, 10)
    if (!Number.isFinite(next)) return
    setDraft(next)
  }

  const handleBlur = (): void => {
    void commit(draft())
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      ;(event.currentTarget as HTMLInputElement).blur()
    }
  }

  const canDec = (): boolean => draft() > MIN_EXTRACT_CONCURRENCY && !pending()
  const canInc = (): boolean => draft() < MAX_EXTRACT_CONCURRENCY && !pending()

  return (
    <div class="border-2 border-border bg-bg px-4 py-4">
      <div class="flex items-start justify-between gap-6">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label
            for="queue-concurrency-extract"
            class="font-mono text-sm font-medium text-text"
          >
            Số job extract chạy song song
          </label>
          <p class="text-xs text-text-muted">
            Số lượng job trích xuất sub / audio chạy đồng thời. Render luôn giới hạn ở 1
            job độc lập. Khoảng hợp lệ: {MIN_EXTRACT_CONCURRENCY}–
            {MAX_EXTRACT_CONCURRENCY}.
          </p>
        </div>
        <div class="flex flex-none items-center">
          <button
            type="button"
            onClick={() => handleStep(-1)}
            disabled={!canDec()}
            class="flex h-11 w-11 items-center justify-center border-2 border-border bg-bg text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
            aria-label="Giảm số job extract song song"
          >
            <Minus size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <input
            id="queue-concurrency-extract"
            type="number"
            min={MIN_EXTRACT_CONCURRENCY}
            max={MAX_EXTRACT_CONCURRENCY}
            value={draft()}
            onInput={handleInput}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            inputmode="numeric"
            class="h-11 w-16 border-y-2 border-border bg-bg text-center font-mono text-base text-text outline-none focus:border-accent"
            aria-label="Số job extract song song"
          />
          <button
            type="button"
            onClick={() => handleStep(1)}
            disabled={!canInc()}
            class="flex h-11 w-11 items-center justify-center border-2 border-border bg-bg text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
            aria-label="Tăng số job extract song song"
          >
            <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

const SettingsToolRow: Component<{ report: ToolReport }> = props => (
  <div class="flex flex-col gap-1 border-b-2 border-border px-4 py-3 last:border-b-0">
    <div class="flex items-center justify-between gap-3">
      <span class="font-mono text-sm font-medium text-text">{props.report.name}</span>
      <StatusBadge tone={tone[props.report.status]}>
        {badgeLabel[props.report.status]}
      </StatusBadge>
    </div>
    <Show
      when={props.report.resolved_path}
      fallback={<p class="text-xs text-text-muted">Không có thông tin đường dẫn.</p>}
    >
      {p => <p class="font-mono text-xs break-all text-text-muted">{p()}</p>}
    </Show>
    <Show when={props.report.detected_version}>
      {v => (
        <p class="font-mono text-xs text-text-muted">
          Phiên bản: <span class="text-text">v{v()}</span>{' '}
          <span class="text-text-muted">(tối thiểu {props.report.minimum_version})</span>
        </p>
      )}
    </Show>
  </div>
)

export default SettingsModal
