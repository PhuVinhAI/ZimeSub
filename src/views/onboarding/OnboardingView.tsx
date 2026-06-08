import Button from '@design-system/Button'
import { rescanTools, toolsStore } from '@stores/tools'
import { RefreshCw } from 'lucide-solid'
import { For, Show, type Component } from 'solid-js'
import ToolRow from './ToolRow'

/**
 * Full-window Onboarding gate shown when one or more `RequiredTool` entries
 * are `Missing` or `Outdated` (per slice 0002).
 *
 * Covers the entire `AppShell` — Sidebar, drag-drop, project actions, and
 * the bottom status bar are all replaced by this single panel. Slice 0003
 * will add winget install buttons + a live log stream beneath the rows; for
 * now we only display detection + the "Quét lại" re-probe action.
 *
 * UI strings: Vietnamese only (PRD § "UI shell & language").
 */
const OnboardingView: Component = () => {
  const handleRescan = () => {
    void rescanTools()
  }

  return (
    <section
      class="flex h-full w-full items-center justify-center overflow-auto bg-bg px-12 py-16"
      aria-label="Thiết lập công cụ"
    >
      <div class="flex w-full max-w-2xl flex-col gap-8">
        <header class="flex flex-col gap-3">
          <h1 class="text-4xl font-semibold tracking-tight text-text">
            Cần cài đặt công cụ trước khi sử dụng
          </h1>
          <p class="text-base leading-relaxed text-text-muted">
            ZimeSub cần 3 công cụ dòng lệnh để hoạt động:{' '}
            <span class="font-mono text-text">mkvmerge</span>,{' '}
            <span class="font-mono text-text">mkvextract</span> (MKVToolNix ≥ 60.0) và{' '}
            <span class="font-mono text-text">ffmpeg</span> (≥ 4.0). Vui lòng cài đặt các
            công cụ thiếu hoặc cập nhật phiên bản cũ rồi nhấn{' '}
            <span class="font-mono text-text">Quét lại</span>.
          </p>
        </header>

        <div class="border-2 border-border bg-surface">
          <div class="border-b-2 border-border px-6 py-4">
            <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
              CÔNG CỤ YÊU CẦU
            </h2>
          </div>

          <div>
            <For each={toolsStore.reports}>{report => <ToolRow report={report} />}</For>
            <Show when={toolsStore.reports.length === 0}>
              <p class="px-6 py-5 text-sm text-text-muted">
                Chưa có kết quả dò công cụ.
              </p>
            </Show>
          </div>
        </div>

        <Show when={toolsStore.error}>
          {err => (
            <div
              class="border-2 border-danger bg-bg px-4 py-3 text-sm text-danger"
              role="alert"
            >
              Lỗi khi dò công cụ: <span class="font-mono">{err()}</span>
            </div>
          )}
        </Show>

        <div class="flex items-center gap-4">
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
          <p class="text-xs text-text-muted">
            Sau khi cài hoặc nâng cấp công cụ, nhấn nút này để dò lại — không cần khởi
            động lại app.
          </p>
        </div>
      </div>
    </section>
  )
}

export default OnboardingView
