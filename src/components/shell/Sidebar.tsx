import type { RecentProjectStatus } from '@api/projects'
import StatusBadge from '@design-system/StatusBadge'
import { formatRelativeVi } from '@lib/time'
import { openProjectByPath, projectsStore, removeRecent } from '@stores/projects'
import { Folder, Plus, Trash2 } from 'lucide-solid'
import { For, Show, type Component } from 'solid-js'

interface SidebarProps {
  onCreateProject: () => void
}

/**
 * Left sidebar — Rounded Flat refresh.
 *
 * Sidebar is a self-contained rounded card on the inset shell. The
 * old "3px accent left border" active marker is replaced by a filled
 * `bg-elevated` pill row + a 6px accent dot on the left, keeping the
 * affordance instantly readable without resorting to a single-side
 * border (which the refresh language treats as visual debris).
 *
 * Sections (wordmark, list, footer CTA) are spaced with padding only —
 * no internal dividing borders, the rounded silhouette stays
 * continuous from top to bottom.
 */
const Sidebar: Component<SidebarProps> = props => {
  return (
    <aside
      class="flex h-full w-[280px] flex-none flex-col overflow-hidden rounded-[28px] border border-border bg-surface"
      aria-label="Thanh điều hướng"
    >
      <div class="px-6 pt-6 pb-4">
        <div class="flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center rounded-2xl bg-accent text-accent-on-accent">
            <Folder size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <span class="font-sans text-base font-semibold tracking-[0.22em] text-text">
            ZIMESUB
          </span>
        </div>
      </div>

      <nav
        class="flex flex-1 flex-col gap-1 overflow-y-auto px-3"
        aria-label="Danh sách project"
      >
        <h2 class="px-3 pt-3 pb-2 font-mono text-[10px] font-semibold tracking-[0.22em] text-text-faint uppercase">
          Projects · {projectsStore.recents.length}
        </h2>
        <Show
          when={projectsStore.recents.length > 0}
          fallback={
            <p class="px-3 pb-5 text-xs leading-relaxed text-text-muted">
              Chưa có project nào. Tạo project mới bằng nút bên dưới.
            </p>
          }
        >
          <ul class="flex flex-col gap-1.5">
            <For each={projectsStore.recents}>
              {recent => <RecentRow recent={recent} />}
            </For>
          </ul>
        </Show>
      </nav>

      <div class="p-4">
        <button
          type="button"
          onClick={() => props.onCreateProject()}
          class="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-sm font-semibold text-accent-on-accent transition-colors hover:bg-text hover:text-bg disabled:cursor-not-allowed disabled:bg-elevated disabled:text-text-faint"
          aria-label="Tạo project mới"
        >
          <Plus size={18} strokeWidth={2} aria-hidden="true" />
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
 * The active project is highlighted with a full `bg-elevated` fill +
 * an accent dot on the left edge of the row (inside the rounded
 * silhouette). Missing rows (folder gone or `zimesub.json` deleted)
 * show a danger badge and a "Gỡ" button instead of opening on click.
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
    <li>
      <button
        type="button"
        onClick={handleOpen}
        disabled={isMissing()}
        class={[
          'group relative flex w-full flex-col gap-1 rounded-2xl px-4 py-3 text-left transition-colors',
          isActive()
            ? 'bg-elevated text-text'
            : 'text-text hover:bg-elevated/60',
          isMissing()
            ? 'cursor-not-allowed opacity-70 hover:bg-transparent'
            : 'cursor-pointer'
        ].join(' ')}
        aria-label={`Mở project ${displayName()}`}
        aria-current={isActive() ? 'true' : undefined}
      >
        <Show when={isActive()}>
          <span
            class="pointer-events-none absolute top-1/2 left-2 h-2 w-2 -translate-y-1/2 rounded-full bg-accent"
            aria-hidden="true"
          />
        </Show>
        <div class="flex items-center justify-between gap-2 pl-3">
          <span
            class={[
              'truncate text-sm font-semibold',
              isActive() ? 'text-text' : 'text-text'
            ].join(' ')}
            title={displayName()}
          >
            {displayName()}
          </span>
          <Show when={isMissing()}>
            <StatusBadge tone="danger" variant="outline">
              Mất
            </StatusBadge>
          </Show>
        </div>
        <Show
          when={!isMissing()}
          fallback={
            <p class="pl-3 font-mono text-[10px] break-all text-text-faint">
              {props.recent.path}
            </p>
          }
        >
          <p class="pl-3 font-mono text-[10px] tracking-wide text-text-muted">
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
            class="mt-2 ml-3 inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-full border border-border bg-bg px-3 text-xs font-medium text-text-muted transition-colors hover:border-accent hover:text-accent"
            aria-label="Gỡ khỏi danh sách"
          >
            <Trash2 size={12} strokeWidth={1.5} aria-hidden="true" />
            <span>Gỡ khỏi danh sách</span>
          </span>
        </Show>
      </button>
    </li>
  )
}

function tailOfPath(p: string): string {
  const normalised = p.replace(/[\\/]+$/, '')
  const idx = Math.max(normalised.lastIndexOf('\\'), normalised.lastIndexOf('/'))
  return idx >= 0 ? normalised.slice(idx + 1) : normalised
}

export default Sidebar
