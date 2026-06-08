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
 * Settings modal — reachable from the gear icon in the bottom status
 * bar after Onboarding closes. Two sections (tool status + queue
 * concurrency), each its own rounded surface card.
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
        <Button variant="primary" onClick={() => props.onClose()} aria-label="Đóng">
          <span>Đóng</span>
        </Button>
      }
    >
      <div class="flex flex-col gap-6 pt-4">
        <section
          class="flex flex-col gap-4 rounded-2xl bg-elevated p-5"
          aria-label="Trạng thái công cụ"
        >
          <div class="flex items-center justify-between gap-4">
            <h3 class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
              Công cụ đã dò
            </h3>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRescan}
              disabled={toolsStore.phase === 'rescanning'}
              aria-label="Quét lại công cụ"
            >
              <RefreshCw
                size={14}
                strokeWidth={1.5}
                aria-hidden="true"
                class={toolsStore.phase === 'rescanning' ? 'animate-spin' : ''}
              />
              <span>
                {toolsStore.phase === 'rescanning' ? 'Đang quét...' : 'Quét lại'}
              </span>
            </Button>
          </div>

          <div class="flex flex-col gap-2">
            <For each={toolsStore.reports}>
              {report => <SettingsToolRow report={report} />}
            </For>
            <Show when={toolsStore.reports.length === 0}>
              <p class="rounded-xl bg-bg px-4 py-3 text-sm text-text-muted">
                Chưa có kết quả dò công cụ.
              </p>
            </Show>
          </div>

          <p class="text-xs leading-relaxed text-text-muted">
            Nhấn <span class="font-mono text-text">Quét lại</span> sau khi bạn vừa cài
            hoặc nâng cấp công cụ bên ngoài app.
          </p>
        </section>

        <section
          class="flex flex-col gap-4 rounded-2xl bg-elevated p-5"
          aria-label="Cấu hình hàng đợi"
        >
          <h3 class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
            Hàng đợi
          </h3>
          <QueueConcurrencyField />
        </section>
      </div>
    </Modal>
  )
}

const QueueConcurrencyField: Component = () => {
  const [draft, setDraft] = createSignal(settingsStore.queueConcurrencyExtract)
  const [pending, setPending] = createSignal(false)

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
    <div class="flex flex-col gap-4 rounded-2xl bg-bg p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <label for="queue-concurrency-extract" class="text-sm font-medium text-text">
          Số job extract chạy song song
        </label>
        <p class="text-xs leading-relaxed text-text-muted">
          Render luôn giới hạn ở 1 job độc lập. Khoảng hợp lệ: {MIN_EXTRACT_CONCURRENCY}–
          {MAX_EXTRACT_CONCURRENCY}.
        </p>
      </div>
      <div class="flex flex-none items-center gap-1 rounded-full border border-border bg-surface p-1">
        <button
          type="button"
          onClick={() => handleStep(-1)}
          disabled={!canDec()}
          class="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-elevated hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Giảm số job extract song song"
        >
          <Minus size={16} strokeWidth={1.5} aria-hidden="true" />
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
          class="h-9 w-12 bg-transparent text-center font-mono text-base text-text outline-none"
          aria-label="Số job extract song song"
        />
        <button
          type="button"
          onClick={() => handleStep(1)}
          disabled={!canInc()}
          class="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-elevated hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Tăng số job extract song song"
        >
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

const SettingsToolRow: Component<{ report: ToolReport }> = props => (
  <div class="flex flex-col gap-1 rounded-xl bg-bg px-4 py-3">
    <div class="flex items-center justify-between gap-3">
      <span class="font-mono text-sm font-medium text-text">{props.report.name}</span>
      <StatusBadge tone={tone[props.report.status]}>
        {badgeLabel[props.report.status]}
      </StatusBadge>
    </div>
    <Show
      when={props.report.resolved_path}
      fallback={
        <p class="text-xs text-text-muted">Không có thông tin đường dẫn.</p>
      }
    >
      {p => <p class="font-mono text-[11px] break-all text-text-muted">{p()}</p>}
    </Show>
    <Show when={props.report.detected_version}>
      {v => (
        <p class="font-mono text-[11px] text-text-muted">
          Phiên bản: <span class="text-text">v{v()}</span>{' '}
          <span class="text-text-faint">(tối thiểu {props.report.minimum_version})</span>
        </p>
      )}
    </Show>
  </div>
)

export default SettingsModal
