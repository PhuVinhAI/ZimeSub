import type { RecentProjectStatus } from '@api/projects'
import StatusBadge from '@design-system/StatusBadge'
import { formatRelativeVi } from '@lib/time'
import { openProjectByPath, projectsStore, removeRecent } from '@stores/projects'
import { Plus, Trash2 } from 'lucide-solid'
import { For, Show, type Component } from 'solid-js'

interface SidebarProps {
  onCreateProject: () => void
}

/**
 * Left sidebar of the app shell (slices 0001 + 0004).
 *
 * Layout:
 *  - Top: ZIMESUB wordmark (slice 0001, unchanged).
 *  - Middle: PROJECTS section. Slice 0004 wires the live recent
 *    projects list from `projectsStore.recents`. Each row shows the
 *    project name + relative last-opened time; the active row has a
 *    3 px accent left border per AC. Rows whose folder or manifest
 *    are missing show a "Không tìm thấy" danger badge and a "Gỡ"
 *    button.
 *  - Bottom: "＋ Tạo project" CTA. Disabled in slice 0001;
 *    slice 0004 wires it to open the Create Project modal.
 *
 * No `shadow-*` / `bg-gradient-*` / `backdrop-blur-*` / `drop-shadow-*` —
 * separators are 2 px solid borders.
 */
const Sidebar: Component<SidebarProps> = props => {
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

      <nav class="flex flex-1 flex-col overflow-y-auto" aria-label="Danh sách project">
        <h2 class="px-6 py-5 text-xs font-semibold tracking-[0.18em] text-text-muted">
          PROJECTS
        </h2>
        <Show
          when={projectsStore.recents.length > 0}
          fallback={<p class="px-6 pb-5 text-sm text-text-muted">Chưa có project nào.</p>}
        >
          <ul class="flex flex-col">
            <For each={projectsStore.recents}>
              {recent => <RecentRow recent={recent} />}
            </For>
          </ul>
        </Show>
      </nav>

      <div class="border-t-2 border-border p-4">
        <button
          type="button"
          onClick={() => props.onCreateProject()}
          class="flex h-11 w-full items-center justify-center gap-2 border-2 border-border bg-bg px-5 py-3 text-sm font-medium text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:text-text"
          aria-label="Tạo project mới"
        >
          <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
          <span>Tạo project</span>
        </button>
      </div>
    </aside>
  )
}

interface RecentRowProps {
  recent: RecentProjectStatus
}

/**
 * One row in the Sidebar recents list.
 *
 * Active project is highlighted with a 3 px accent left border (per AC).
 * Missing rows (folder gone, or `zimesub.json` deleted) show a danger
 * badge and a "Gỡ" button instead of opening on click.
 */
const RecentRow: Component<RecentRowProps> = props => {
  const isActive = (): boolean => {
    const activeFolder = projectsStore.activeFolder
    if (!activeFolder) return false
    return activeFolder.toLowerCase() === props.recent.path.toLowerCase()
  }

  const isMissing = (): boolean => {
    return !props.recent.folder_exists || !props.recent.has_zimesub_json
  }

  const displayName = (): string => {
    if (props.recent.name) return props.recent.name
    return tailOfPath(props.recent.path)
  }

  const handleOpen = (): void => {
    if (isMissing()) return
    void openProjectByPath(props.recent.path)
  }

  const handleRemove = (event: MouseEvent): void => {
    event.stopPropagation()
    void removeRecent(props.recent.path)
  }

  return (
    <li class="contents">
      <button
        type="button"
        onClick={handleOpen}
        disabled={isMissing()}
        class={[
          'flex w-full flex-col gap-1 border-b-2 border-border px-6 py-3 text-left transition-colors',
          'border-l-[3px]',
          isActive() ? 'border-l-accent' : 'border-l-transparent',
          isMissing()
            ? 'cursor-not-allowed opacity-70 hover:bg-bg'
            : 'cursor-pointer hover:bg-bg'
        ].join(' ')}
        aria-label={`Mở project ${displayName()}`}
        aria-current={isActive() ? 'true' : undefined}
      >
        <div class="flex items-center justify-between gap-2">
          <span
            class={[
              'truncate text-sm font-medium',
              isActive() ? 'text-text' : 'text-text'
            ].join(' ')}
            title={displayName()}
          >
            {displayName()}
          </span>
          <Show when={isMissing()}>
            <StatusBadge tone="danger">Không tìm thấy</StatusBadge>
          </Show>
        </div>
        <Show
          when={!isMissing()}
          fallback={
            <p class="font-mono text-xs break-all text-text-muted">{props.recent.path}</p>
          }
        >
          <p class="font-mono text-xs text-text-muted">
            {formatRelativeVi(props.recent.last_opened)}
          </p>
        </Show>
        <Show when={isMissing()}>
          <span
            role="button"
            tabindex="0"
            onClick={handleRemove}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleRemove(e as unknown as MouseEvent)
              }
            }}
            class="mt-2 inline-flex h-8 items-center justify-center gap-1.5 border-2 border-border bg-bg px-2 text-xs font-medium text-text-muted transition-colors hover:border-accent hover:text-accent"
            aria-label="Gỡ khỏi danh sách"
          >
            <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>Gỡ khỏi danh sách</span>
          </span>
        </Show>
      </button>
    </li>
  )
}

/**
 * Last path segment, for use when a recent project's name can't be
 * read (folder is missing, manifest corrupt). Handles both Windows
 * backslash and forward slash without pulling in a path lib.
 */
function tailOfPath(p: string): string {
  const normalised = p.replace(/[\\/]+$/, '')
  const idx = Math.max(normalised.lastIndexOf('\\'), normalised.lastIndexOf('/'))
  return idx >= 0 ? normalised.slice(idx + 1) : normalised
}

export default Sidebar
