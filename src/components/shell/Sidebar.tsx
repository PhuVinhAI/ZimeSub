import { Plus } from 'lucide-solid'
import type { Component } from 'solid-js'

/**
 * Left sidebar of the app shell.
 *
 * Layout (per docs/style-guide.md):
 *  - Fixed 280px wide
 *  - Top: ZIMESUB wordmark
 *  - Middle: PROJECTS section (empty in 0001 — populated in slice 0004)
 *  - Bottom: primary CTA "Tạo project"
 *
 * No `shadow-*` / `bg-gradient-*` / `backdrop-blur-*` / `drop-shadow-*` —
 * separators are 2px solid borders.
 */
const Sidebar: Component = () => {
  return (
    <aside
      class="flex h-full w-[280px] flex-none flex-col border-r-2 border-border bg-surface"
      aria-label="Thanh điều hướng"
    >
      <div class="border-b-2 border-border px-6 py-5">
        <span class="font-sans text-base font-semibold tracking-[0.18em] text-text">
          ZIMESUB
        </span>
      </div>

      <nav class="flex flex-1 flex-col overflow-y-auto px-6 py-5">
        <h2 class="text-xs font-semibold tracking-[0.18em] text-text-muted">PROJECTS</h2>
        <p class="mt-4 text-sm text-text-muted">Chưa có project nào.</p>
      </nav>

      <div class="border-t-2 border-border p-4">
        <button
          type="button"
          disabled
          class="flex h-11 w-full items-center justify-center gap-2 border-2 border-border bg-bg px-5 py-3 text-sm font-medium text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:text-text"
          aria-label="Tạo project mới"
          title="Sẽ có ở slice tiếp theo"
        >
          <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
          <span>Tạo project</span>
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
