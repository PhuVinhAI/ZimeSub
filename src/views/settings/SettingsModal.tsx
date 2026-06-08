import type { ToolReport, ToolStatus } from '@api/tooling'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import StatusBadge, { type BadgeTone } from '@design-system/StatusBadge'
import { rescanTools, toolsStore } from '@stores/tools'
import { RefreshCw } from 'lucide-solid'
import { For, Show, type Component } from 'solid-js'

/**
 * Settings modal — reachable after Onboarding closes via the gear icon in
 * the bottom status bar. Slice 0003 only surfaces the "Quét lại" affordance
 * (PRD user story 5 — "Re-check tools" from Settings without restart) and a
 * read-only summary of the cached `RequiredTool` reports. Future slices
 * (queue concurrency, default render config, etc.) layer in on top.
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
            <p class="px-4 py-3 text-sm text-text-muted">
              Chưa có kết quả dò công cụ.
            </p>
          </Show>
        </div>

        <p class="text-xs text-text-muted">
          Nhấn <span class="font-mono text-text">Quét lại</span> sau khi bạn vừa cài
          hoặc nâng cấp công cụ bên ngoài app.
        </p>
      </section>
    </Modal>
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
      fallback={
        <p class="text-xs text-text-muted">Không có thông tin đường dẫn.</p>
      }
    >
      {p => <p class="font-mono text-xs break-all text-text-muted">{p()}</p>}
    </Show>
    <Show when={props.report.detected_version}>
      {v => (
        <p class="font-mono text-xs text-text-muted">
          Phiên bản: <span class="text-text">v{v()}</span>{' '}
          <span class="text-text-muted">
            (tối thiểu {props.report.minimum_version})
          </span>
        </p>
      )}
    </Show>
  </div>
)

export default SettingsModal
