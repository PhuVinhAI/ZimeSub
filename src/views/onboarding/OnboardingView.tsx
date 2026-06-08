import Button from '@design-system/Button'
import Stepper, { type Step, type StepStatus } from '@design-system/Stepper'
import TerminalLog from '@design-system/TerminalLog'
import {
  clearInstallState,
  rescanTools,
  toolsStore,
  type InstallPhase
} from '@stores/tools'
import { RefreshCw, Sparkles, Trash2 } from 'lucide-solid'
import { For, Show, type Component } from 'solid-js'
import ToolRow from './ToolRow'

/**
 * Onboarding wizard — Rounded Flat refresh.
 *
 * Full-window setup gate shown when one or more `RequiredTool` entries
 * are `Missing` or `Outdated`. Restructured as a true three-step
 * wizard:
 *
 *   ① mkvmerge → ② mkvextract → ③ ffmpeg
 *
 * The stepper at the top visualises progress at a glance; the body
 * still renders the existing `ToolRow` install affordances unchanged
 * (the rounded shell takes care of the visual polish).
 *
 * UI strings: Vietnamese only.
 */
const OnboardingView: Component = () => {
  const handleRescan = (): void => {
    void rescanTools()
  }

  const stepperSteps = (): Step[] => {
    return toolsStore.reports.map((report): Step => {
      const status: StepStatus =
        report.status === 'Ready'
          ? 'done'
          : report.status === 'Outdated'
            ? 'error'
            : 'current'
      return {
        id: report.name,
        label: report.name,
        sublabel:
          report.status === 'Ready'
            ? `v${report.detected_version ?? '—'}`
            : report.status === 'Outdated'
              ? `cần ≥ v${report.minimum_version}`
              : 'chưa cài',
        status
      }
    })
  }

  return (
    <section
      class="flex h-full w-full items-start justify-center overflow-auto bg-bg px-12 py-12"
      aria-label="Thiết lập công cụ"
    >
      <div class="flex w-full max-w-3xl flex-col gap-8">
        <header class="flex flex-col gap-5 rounded-[32px] border border-border bg-surface px-8 py-8">
          <div class="flex items-center gap-3">
            <span class="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-accent-on-accent">
              <Sparkles size={20} strokeWidth={2} aria-hidden="true" />
            </span>
            <span class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
              Wizard · Cài đặt môi trường
            </span>
          </div>
          <div class="flex flex-col gap-3">
            <h1 class="text-4xl font-semibold tracking-tight text-text">
              Cần ba công cụ trước khi bắt đầu
            </h1>
            <p class="text-base leading-relaxed text-text-muted">
              ZimeSub cần{' '}
              <span class="font-mono text-text">mkvmerge</span>,{' '}
              <span class="font-mono text-text">mkvextract</span> (MKVToolNix ≥ 60.0) và{' '}
              <span class="font-mono text-text">ffmpeg</span> (≥ 4.0). Nhấn{' '}
              <span class="font-mono text-text">Cài đặt</span> để dùng{' '}
              <span class="font-mono text-text">winget</span>, hoặc{' '}
              <span class="font-mono text-text">Quét lại</span> sau khi cài tay.
            </p>
          </div>
          <Show when={stepperSteps().length > 0}>
            <div class="pt-2">
              <Stepper steps={stepperSteps()} size="comfortable" />
            </div>
          </Show>
        </header>

        <section
          class="overflow-hidden rounded-[28px] border border-border bg-surface"
          aria-label="Công cụ yêu cầu"
        >
          <header class="flex items-center justify-between gap-3 px-7 pt-6 pb-3">
            <h2 class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
              Công cụ yêu cầu
            </h2>
            <span class="font-mono text-[10px] tracking-[0.18em] text-text-faint uppercase">
              {toolsStore.reports.filter(r => r.status === 'Ready').length} /{' '}
              {toolsStore.reports.length} sẵn sàng
            </span>
          </header>
          <div class="flex flex-col gap-3 px-4 pt-1 pb-5">
            <For each={toolsStore.reports}>
              {(report, idx) => <ToolRow report={report} stepNumber={idx() + 1} />}
            </For>
            <Show when={toolsStore.reports.length === 0}>
              <p class="px-3 py-4 text-sm text-text-muted">Chưa có kết quả dò công cụ.</p>
            </Show>
          </div>
        </section>

        <Show when={toolsStore.wingetAvailable === false}>
          <p
            class="rounded-2xl border border-warn/40 bg-warn-soft px-5 py-4 text-sm text-warn"
            role="alert"
          >
            Không tìm thấy <span class="font-mono">winget</span> trên máy này. Hãy dùng nút
            "Mở trang tải" để tải MKVToolNix / FFmpeg, sau đó nhấn "Tôi đã cài".
          </p>
        </Show>

        <Show
          when={shouldShowLogPanel(
            toolsStore.install.phase,
            toolsStore.install.logs.length
          )}
        >
          <InstallLogPanel />
        </Show>

        <Show when={toolsStore.error}>
          {err => (
            <p
              class="rounded-2xl border border-danger/40 bg-danger-soft px-5 py-4 text-sm text-danger"
              role="alert"
            >
              Lỗi khi dò công cụ: <span class="font-mono">{err()}</span>
            </p>
          )}
        </Show>

        <div class="flex flex-wrap items-center gap-4 rounded-[28px] border border-border bg-surface px-6 py-5">
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
            <span>{toolsStore.phase === 'rescanning' ? 'Đang quét...' : 'Quét lại'}</span>
          </Button>
          <p class="flex-1 text-xs leading-relaxed text-text-muted">
            Sau khi cài hoặc nâng cấp công cụ, nhấn nút này để dò lại — không cần khởi
            động lại app.
          </p>
        </div>
      </div>
    </section>
  )
}

function shouldShowLogPanel(phase: InstallPhase, logCount: number): boolean {
  if (phase === 'running') return true
  if (phase === 'idle') return false
  return logCount > 0 || phase === 'failed' || phase === 'cancelled'
}

const InstallLogPanel: Component = () => {
  const banner = () =>
    bannerForPhase(toolsStore.install.phase, toolsStore.install.exitCode)

  return (
    <section
      class="flex flex-col gap-4 rounded-[28px] border border-border bg-surface px-6 py-6"
      aria-label="Nhật ký cài đặt"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
          Nhật ký cài đặt
          <Show when={toolsStore.install.tool}>
            {t => <span class="text-text"> · {t()}</span>}
          </Show>
        </h2>
        <Show when={toolsStore.install.phase !== 'running'}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clearInstallState()}
            aria-label="Đóng nhật ký"
          >
            <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>Đóng</span>
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
            class={['rounded-2xl border px-5 py-4 text-sm', b().toneClass].join(' ')}
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

function bannerForPhase(
  phase: InstallPhase,
  exitCode: number | null
): InstallBanner | null {
  switch (phase) {
    case 'success':
      return {
        message: 'Cài đặt hoàn tất — đang dò lại công cụ...',
        toneClass: 'border-accent/40 bg-accent-soft text-accent'
      }
    case 'failed':
      return {
        message: `winget thoát với mã ${exitCode ?? 'không xác định'}. Hãy xem log phía trên rồi nhấn "Thử lại".`,
        toneClass: 'border-danger/40 bg-danger-soft text-danger'
      }
    case 'cancelled':
      return {
        message: 'Đã hủy cài đặt. Có thể nhấn "Thử lại" hoặc cài thủ công.',
        toneClass: 'border-warn/40 bg-warn-soft text-warn'
      }
    default:
      return null
  }
}

export default OnboardingView
