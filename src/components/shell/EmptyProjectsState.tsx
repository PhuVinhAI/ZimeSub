import type { Component } from 'solid-js'

/**
 * Default Main content when no Project is open.
 *
 * Slice 0004 swaps this out for the active Project view; 0001 just renders
 * the empty state.
 */
const EmptyProjectsState: Component = () => {
  return (
    <div class="flex h-full w-full items-center justify-center px-12 py-16">
      <div class="max-w-md text-center">
        <h1 class="text-5xl font-semibold tracking-tight text-text">
          Chưa có project nào
        </h1>
        <p class="mt-4 text-base leading-relaxed text-text-muted">
          Tạo một project mới để bắt đầu pipeline làm phụ đề tiếng Việt cho anime.
        </p>
      </div>
    </div>
  )
}

export default EmptyProjectsState
