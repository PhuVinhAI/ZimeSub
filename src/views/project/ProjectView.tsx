import { pickMkvFiles } from '@api/dialog'
import type { EpisodeRecord, ProjectJson } from '@api/projects'
import Button from '@design-system/Button'
import StatusBadge from '@design-system/StatusBadge'
import { addEpisodes } from '@stores/projects'
import { FilePlus2, Plus } from 'lucide-solid'
import { createSignal, For, Show, type Component } from 'solid-js'

interface ProjectViewProps {
  project: ProjectJson
  folder: string
}

/**
 * Main view when a project is open.
 *
 * Slice 0004 rendered the project header + an empty-state placeholder.
 * Slice 0005 wires:
 *   * "Thêm Episode…" button — opens the multi-file MKV picker as the
 *     keyboard-only alternative to drag-drop.
 *   * Episode list rows — folder name (with full source path on hover),
 *     `source_mkv_path` in mono, "Trống" badge until the pipeline
 *     produces artefacts (slices 0006+ derive richer EpisodeState).
 *
 * The drag-drop overlay itself is hosted by `AppShell` so it covers the
 * whole window (Sidebar + StatusBar included), per the AC.
 */
const ProjectView: Component<ProjectViewProps> = props => {
  const [picking, setPicking] = createSignal(false)

  const handlePickFiles = async (): Promise<void> => {
    if (picking()) return
    setPicking(true)
    try {
      const paths = await pickMkvFiles('Chọn file MKV để thêm Episode')
      if (paths.length === 0) return
      await addEpisodes(paths)
    } finally {
      setPicking(false)
    }
  }

  return (
    <section
      class="flex h-full w-full flex-col overflow-auto px-12 py-10"
      aria-label="Project đang mở"
    >
      <header class="flex flex-col gap-2 border-b-2 border-border pb-6">
        <h1 class="text-5xl font-semibold tracking-tight text-text">
          {props.project.name}
        </h1>
        <p class="font-mono text-xs break-all text-text-muted">{props.folder}</p>
      </header>

      <div class="mt-8 flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            EPISODES · {props.project.episodes.length}
          </h2>
          <Button
            variant="secondary"
            onClick={() => void handlePickFiles()}
            disabled={picking()}
            aria-label="Thêm Episode bằng cách chọn file MKV"
          >
            <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>Thêm Episode…</span>
          </Button>
        </div>

        <Show when={props.project.episodes.length > 0} fallback={<EpisodeListEmpty />}>
          <ul class="flex flex-col border-2 border-border" aria-label="Danh sách Episode">
            <For each={props.project.episodes}>
              {(episode, index) => (
                <EpisodeRow
                  episode={episode}
                  isLast={index() === props.project.episodes.length - 1}
                />
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  )
}

interface EpisodeRowProps {
  episode: EpisodeRecord
  isLast: boolean
}

/**
 * One row in the Episode list.
 *
 * Layout: folder name (truncated, full path on title hover) + source
 * MKV path in mono + "Trống" badge. Slices 0006+ swap the badge for a
 * derived `EpisodeState` (Empty | Extracting | Extracted | Translating
 * | Translated | Rendering | Rendered, with MissingSource overlay).
 */
const EpisodeRow: Component<EpisodeRowProps> = props => {
  return (
    <li
      class={[
        'flex items-center justify-between gap-6 px-5 py-4',
        props.isLast ? '' : 'border-b-2 border-border'
      ].join(' ')}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span
          class="truncate text-base font-medium text-text"
          title={props.episode.source_mkv_path}
        >
          {props.episode.folder_name}
        </span>
        <span
          class="truncate font-mono text-xs text-text-muted"
          title={props.episode.source_mkv_path}
        >
          {props.episode.source_mkv_path}
        </span>
      </div>
      <StatusBadge tone="accent">Trống</StatusBadge>
    </li>
  )
}

/**
 * Empty-state for the Episode list — the AC strings exactly. Slice 0005
 * keeps this prompt around even though the drag overlay is wired,
 * because users land on the empty Project view before initiating their
 * first drag.
 */
const EpisodeListEmpty: Component = () => (
  <div
    class="flex min-h-[260px] flex-col items-center justify-center gap-3 border-2 border-dashed border-border bg-bg px-6 py-12 text-center"
    aria-label="Chưa có episode nào"
  >
    <FilePlus2 size={32} strokeWidth={1.5} class="text-text-muted" aria-hidden="true" />
    <p class="text-base text-text">Thả file MKV vào đây để thêm Episode</p>
    <p class="font-mono text-xs text-text-muted">
      Hoặc dùng nút "Thêm Episode…" để chọn file qua hộp thoại.
    </p>
  </div>
)

export default ProjectView
