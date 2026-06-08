import type { Component } from 'solid-js'

/**
 * Bottom status bar.
 *
 * Fixed 56px tall (per docs/style-guide.md). In 0001 it is a placeholder —
 * the live `JobQueue` summary + per-job progress is wired in slice 0008.
 */
const StatusBar: Component = () => {
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
    </footer>
  )
}

export default StatusBar
