import { Settings } from 'lucide-solid'
import type { Component } from 'solid-js'

/**
 * Bottom status bar.
 *
 * Fixed 56px tall (per docs/style-guide.md). In 0001 it was a placeholder;
 * slice 0003 adds a Settings (gear) trigger on the right edge — the only
 * post-Onboarding entry point to the Settings modal where the "Quét lại"
 * action lives (PRD user story 5). The live `JobQueue` summary lands in
 * slice 0008.
 */
interface StatusBarProps {
  onOpenSettings: () => void
}

const StatusBar: Component<StatusBarProps> = props => {
  return (
    <footer
      class="flex h-14 flex-none items-center justify-between border-t-2 border-border bg-surface px-6"
      aria-label="Trạng thái hàng đợi"
    >
      <div class="flex items-center gap-3 font-mono text-sm text-text-muted">
        <span class="text-xs font-semibold tracking-[0.18em] text-text">JOBS</span>
        <span aria-hidden="true">—</span>
        <span>chưa có job nào</span>
      </div>

      <button
        type="button"
        onClick={() => props.onOpenSettings()}
        class="flex h-9 w-9 items-center justify-center border-2 border-transparent text-text-muted transition-colors hover:border-border hover:text-text"
        aria-label="Mở cài đặt"
        title="Cài đặt"
      >
        <Settings size={18} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </footer>
  )
}

export default StatusBar
