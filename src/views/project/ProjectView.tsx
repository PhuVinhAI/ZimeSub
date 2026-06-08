import type { ProjectJson } from '@api/projects'
import { FilePlus2 } from 'lucide-solid'
import { Show, type Component } from 'solid-js'

interface ProjectViewProps {
  project: ProjectJson
  folder: string
}

/**
 * Main view when a project is open (slice 0004).
 *
 * Renders the project name as the page heading, the project folder path
 * in mono below it, and an Episode list placeholder. The drag-drop
 * overlay + actual Episode list land in slice 0005 — for now the
 * placeholder shows the prompt from the acceptance criteria
 * ("Thả file MKV vào đây để thêm Episode").
 */
const ProjectView: Component<ProjectViewProps> = props => {
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
        <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
          EPISODES
        </h2>
        <Show
          when={props.project.episodes.length > 0}
          fallback={<EpisodeListEmpty />}
        >
          <p class="text-sm text-text-muted">
            {props.project.episodes.length} episode đã được thêm.
          </p>
        </Show>
      </div>
    </section>
  )
}

/**
 * Empty-state for the Episode list — the AC strings exactly. Drag-drop
 * wiring lands in slice 0005; this primitive only renders the prompt.
 */
const EpisodeListEmpty: Component = () => (
  <div
    class="flex min-h-[260px] flex-col items-center justify-center gap-3 border-2 border-dashed border-border bg-bg px-6 py-12 text-center"
    aria-label="Chưa có episode nào"
  >
    <FilePlus2 size={32} strokeWidth={1.5} class="text-text-muted" aria-hidden="true" />
    <p class="text-base text-text">Thả file MKV vào đây để thêm Episode</p>
    <p class="font-mono text-xs text-text-muted">
      Chức năng drag-drop sẽ có ở slice tiếp theo.
    </p>
  </div>
)

export default ProjectView
