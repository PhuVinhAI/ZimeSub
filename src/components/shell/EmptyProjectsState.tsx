import { FolderPlus } from 'lucide-solid'
import type { Component } from 'solid-js'

/**
 * Default Main content when no Project is open.
 *
 * Used as a fallback while the projects store is empty (no recents),
 * or right after the user dismissed every project from the sidebar.
 * The keyboard shortcut hint encourages discovery of `Ctrl+N`.
 */
const EmptyProjectsState: Component = () => {
  return (
    <div class="flex h-full w-full items-center justify-center px-12 py-16">
      <div class="flex max-w-lg flex-col items-center gap-6 text-center">
        <span
          class="flex h-24 w-24 items-center justify-center rounded-[28px] border border-border bg-elevated text-text-muted"
          aria-hidden="true"
        >
          <FolderPlus size={36} strokeWidth={1.5} />
        </span>
        <div class="flex flex-col gap-3">
          <h1 class="text-4xl font-semibold tracking-tight text-text">
            Chưa có project nào
          </h1>
          <p class="text-base leading-relaxed text-text-muted">
            Tạo một project để bắt đầu pipeline phụ đề tiếng Việt cho anime — từ trích xuất
            sub, dịch, đến render hardsub.
          </p>
        </div>
        <p class="rounded-full border border-border bg-bg px-4 py-2 font-mono text-[11px] tracking-[0.18em] text-text-faint uppercase">
          Phím tắt · Ctrl + N
        </p>
      </div>
    </div>
  )
}

export default EmptyProjectsState
