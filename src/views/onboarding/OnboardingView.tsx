import Button from '@design-system/Button'
import TerminalLog from '@design-system/TerminalLog'
import {
  clearInstallState,
  rescanTools,
  toolsStore,
  type InstallPhase
} from '@stores/tools'
import { RefreshCw, Trash2 } from 'lucide-solid'
import { For, Show, type Component } from 'solid-js'
import ToolRow from './ToolRow'

/**
 * Full-window Onboarding gate shown when one or more `RequiredTool` entries
 * are `Missing` or `Outdated`.
 *
 * Layout (top → bottom):
 *  1. Title + body copy
 *  2. RequiredTool panel — one `ToolRow` each with status badge + install
 *     button (or manual-download fallback when winget is unavailable).
 *  3. Install log panel — visible whenever an install is or was running,
 *     with the live `TerminalLog` and a completion banner.
 *  4. "Quét lại" button — re-runs detection without touching installs.
 *
 * UI strings: Vietnamese only (PRD § "UI shell & language").
 */
const OnboardingView: Component = () => {
  const handleRescan = (): void => {
    void rescanTools()
  }

  return (
    <section
      class="flex h-full w-full items-start justify-center overflow-auto bg-bg px-12 py-16"
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
            <span class="font-mono text-text">ffmpeg</span> (≥ 4.0). Nhấn{' '}
            <span class="font-mono text-text">Cài đặt</span> để tự động cài qua{' '}
            <span class="font-mono text-text">winget</span>, hoặc{' '}
            <span class="font-mono text-text">Quét lại</span> sau khi cài tay.
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

        <Show when={toolsStore.wingetAvailable === false}>
          <p class="border-2 border-warn bg-bg px-4 py-3 text-xs text-warn">
            Không tìm thấy <span class="font-mono">winget</span> trên máy này. Hãy dùng
            nút "Mở trang tải" để tải MKVToolNix / FFmpeg, sau đó nhấn "Tôi đã cài".
          </p>
        </Show>

        <Show when={shouldShowLogPanel(toolsStore.install.phase, toolsStore.install.logs.length)}>
          <InstallLogPanel />
        </Show>

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
            variant="secondary"
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

/**
 * Show the panel whenever an install is in progress or has produced any
 * output this session. Successful installs are hidden once their logs are
 * cleared, keeping the Onboarding view tidy between attempts.
 */
function shouldShowLogPanel(phase: InstallPhase, logCount: number): boolean {
  if (phase === 'running') return true
  if (phase === 'idle') return false
  return logCount > 0 || phase === 'failed' || phase === 'cancelled'
}

const InstallLogPanel: Component = () => {
  const banner = () => bannerForPhase(toolsStore.install.phase, toolsStore.install.exitCode)

  return (
    <section class="flex flex-col gap-3" aria-label="Nhật ký cài đặt">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
          NHẬT KÝ CÀI ĐẶT
          <Show when={toolsStore.install.tool}>
            {t => <span class="text-text"> · {t()}</span>}
          </Show>
        </h2>
        <Show when={toolsStore.install.phase !== 'running'}>
          <Button
            variant="secondary"
            onClick={() => clearInstallState()}
            aria-label="Đóng nhật ký"
          >
            <Trash2 size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>Đóng nhật ký</span>
          </Button>
        </Show>
      </div>

      <TerminalLog
        lines={toolsStore.install.logs}
        ariaLabel="Đầu ra winget"
        emptyHint="Đang chờ winget khởi động..."
      />

      <Show when={banner()}>
        {b => (
          <div
            class={['border-2 px-4 py-3 text-sm', b().toneClass].join(' ')}
            role="status"
          >
            <p>{b().message}</p>
            <Show when={toolsStore.install.error}>
              {err => <p class="mt-1 font-mono text-xs">{err()}</p>}
            </Show>
          </div>
        )}
      </Show>
    </section>
  )
}

interface InstallBanner {
  message: string
  toneClass: string
}

function bannerForPhase(phase: InstallPhase, exitCode: number | null): InstallBanner | null {
  switch (phase) {
    case 'success':
      return {
        message: 'Cài đặt hoàn tất — đang dò lại công cụ...',
        toneClass: 'border-accent bg-bg text-accent'
      }
    case 'failed':
      return {
        message: `winget thoát với mã ${exitCode ?? 'không xác định'}. Hãy xem log phía trên rồi nhấn "Thử lại".`,
        toneClass: 'border-danger bg-bg text-danger'
      }
    case 'cancelled':
      return {
        message: 'Đã hủy cài đặt. Có thể nhấn "Thử lại" hoặc cài thủ công.',
        toneClass: 'border-warn bg-bg text-warn'
      }
    default:
      return null
  }
}

export default OnboardingView
