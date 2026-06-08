import { openUrl } from '@api/opener'
import type { ToolName, ToolReport, ToolStatus } from '@api/tooling'
import Button from '@design-system/Button'
import StatusBadge, { type BadgeTone } from '@design-system/StatusBadge'
import {
  cancelInstall,
  isInstallingTool,
  isLastInstallForTool,
  manualReprobe,
  startInstall,
  toolsStore
} from '@stores/tools'
import { Download, ExternalLink, RefreshCw, X } from 'lucide-solid'
import { Match, Show, Switch, type Component } from 'solid-js'

/**
 * One row of the Onboarding tool wizard — Rounded Flat refresh.
 *
 * Each tool sits in its own rounded `bg-elevated` card. The leading
 * step number turns the wizard's top-level Stepper into a 1:1 visual
 * anchor: row N's bullet on top matches step N here in the body.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────┐
 *   │ ① mkvmerge                          [Sẵn sàng] v84 │
 *   │ C:\Program Files\MKVToolNix\mkvmerge.exe           │
 *   │                       [Cài đặt] / [Hủy] / [Thử lại] │
 *   └────────────────────────────────────────────────────┘
 */
interface ToolRowProps {
  report: ToolReport
  /** 1-based step number shown in the leading bullet. */
  stepNumber: number
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

const downloadUrl: Record<ToolName, string> = {
  mkvmerge: 'https://mkvtoolnix.download/downloads.html#windows',
  mkvextract: 'https://mkvtoolnix.download/downloads.html#windows',
  ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/'
}

const ToolRow: Component<ToolRowProps> = props => {
  const isNotReady = (): boolean => props.report.status !== 'Ready'
  const installingThis = (): boolean => isInstallingTool(props.report.name)
  const anyInstallRunning = (): boolean => toolsStore.install.phase === 'running'
  const isReady = (): boolean => props.report.status === 'Ready'

  const handleInstall = (): void => {
    void startInstall(props.report.name)
  }

  const handleCancel = (): void => {
    void cancelInstall()
  }

  const handleRetry = (): void => {
    void startInstall(props.report.name)
  }

  const handleOpenDownload = (): void => {
    void openUrl(downloadUrl[props.report.name])
  }

  const handleManualReprobe = (): void => {
    void manualReprobe()
  }

  return (
    <div class="flex flex-col gap-4 rounded-2xl bg-elevated px-5 py-5">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <span
            class={[
              'flex h-9 w-9 flex-none items-center justify-center rounded-full font-mono text-xs font-semibold',
              isReady()
                ? 'bg-accent text-accent-on-accent'
                : 'border border-border bg-bg text-text-muted'
            ].join(' ')}
            aria-hidden="true"
          >
            {String(props.stepNumber).padStart(2, '0')}
          </span>
          <div class="flex items-baseline gap-3">
            <span class="font-mono text-base font-semibold text-text">
              {props.report.name}
            </span>
            <Show when={props.report.detected_version}>
              {v => <span class="font-mono text-xs text-text-faint">v{v()}</span>}
            </Show>
          </div>
        </div>
        <StatusBadge tone={tone[props.report.status]}>
          {badgeLabel[props.report.status]}
        </StatusBadge>
      </div>

      <Switch>
        <Match when={props.report.status === 'Ready' && props.report.resolved_path}>
          {p => (
            <p class="rounded-xl border border-border bg-bg px-3 py-2 font-mono text-xs break-all text-text-muted">
              {p()}
            </p>
          )}
        </Match>

        <Match when={props.report.status === 'Outdated'}>
          <div class="flex flex-col gap-1.5">
            <Show when={props.report.resolved_path}>
              {p => (
                <p class="rounded-xl border border-border bg-bg px-3 py-2 font-mono text-xs break-all text-text-muted">
                  {p()}
                </p>
              )}
            </Show>
            <p class="text-xs text-warn">
              Phiên bản hiện tại{' '}
              <span class="font-mono">
                {props.report.detected_version ?? 'không đọc được'}
              </span>{' '}
              — yêu cầu tối thiểu{' '}
              <span class="font-mono">{props.report.minimum_version}</span>.
            </p>
          </div>
        </Match>

        <Match when={props.report.status === 'Missing'}>
          <p class="text-xs leading-relaxed text-text-muted">
            Không tìm thấy trong PATH hoặc thư mục cài đặt mặc định trên Windows.
          </p>
        </Match>
      </Switch>

      <Show when={isNotReady()}>
        <div class="flex flex-wrap items-center gap-3">
          <Switch>
            <Match when={toolsStore.wingetAvailable === true}>
              <Show
                when={installingThis()}
                fallback={
                  <ReadyToInstallActions
                    disabled={anyInstallRunning()}
                    onInstall={handleInstall}
                    lastFailed={
                      isLastInstallForTool(props.report.name) &&
                      (toolsStore.install.phase === 'failed' ||
                        toolsStore.install.phase === 'cancelled')
                    }
                    onRetry={handleRetry}
                  />
                }
              >
                <InstallingActions onCancel={handleCancel} />
              </Show>
            </Match>

            <Match when={toolsStore.wingetAvailable === false}>
              <ManualFallbackActions
                onOpen={handleOpenDownload}
                onReprobe={handleManualReprobe}
                reprobing={toolsStore.phase === 'rescanning'}
              />
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  )
}

const ReadyToInstallActions: Component<{
  disabled: boolean
  onInstall: () => void
  lastFailed: boolean
  onRetry: () => void
}> = props => (
  <Show
    when={props.lastFailed}
    fallback={
      <Button
        variant="primary"
        onClick={props.onInstall}
        disabled={props.disabled}
        aria-label="Cài đặt qua winget"
      >
        <Download size={18} strokeWidth={1.5} aria-hidden="true" />
        <span>Cài đặt</span>
      </Button>
    }
  >
    <Button
      variant="primary"
      onClick={props.onRetry}
      disabled={props.disabled}
      aria-label="Thử cài đặt lại"
    >
      <RefreshCw size={18} strokeWidth={1.5} aria-hidden="true" />
      <span>Thử lại</span>
    </Button>
  </Show>
)

const InstallingActions: Component<{ onCancel: () => void }> = props => (
  <>
    <Button variant="secondary" disabled aria-label="Đang cài đặt">
      <RefreshCw size={18} strokeWidth={1.5} aria-hidden="true" class="animate-spin" />
      <span>Đang cài...</span>
    </Button>
    <Button variant="ghost" onClick={props.onCancel} aria-label="Hủy cài đặt">
      <X size={18} strokeWidth={1.5} aria-hidden="true" />
      <span>Hủy</span>
    </Button>
  </>
)

const ManualFallbackActions: Component<{
  onOpen: () => void
  onReprobe: () => void
  reprobing: boolean
}> = props => (
  <>
    <Button variant="primary" onClick={props.onOpen} aria-label="Mở trang tải">
      <ExternalLink size={18} strokeWidth={1.5} aria-hidden="true" />
      <span>Mở trang tải</span>
    </Button>
    <Button
      variant="secondary"
      onClick={props.onReprobe}
      disabled={props.reprobing}
      aria-label="Tôi đã cài"
    >
      <RefreshCw
        size={18}
        strokeWidth={1.5}
        aria-hidden="true"
        class={props.reprobing ? 'animate-spin' : ''}
      />
      <span>{props.reprobing ? 'Đang quét...' : 'Tôi đã cài'}</span>
    </Button>
  </>
)

export default ToolRow
