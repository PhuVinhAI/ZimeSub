import DropOverlay from '@components/drop-overlay/DropOverlay'
import EmptyProjectsState from '@components/shell/EmptyProjectsState'
import Sidebar from '@components/shell/Sidebar'
import StatusBar from '@components/shell/StatusBar'
import ToastStack from '@design-system/ToastStack'
import { installGlobalShortcuts } from '@lib/keyboard/globalShortcuts'
import { useKeyboardShortcut } from '@lib/keyboard/useKeyboardShortcut'
import { ensureJobSubscriptions, setActiveProject } from '@stores/jobs'
import { addEpisodes, bootstrapActiveProject, projectsStore } from '@stores/projects'
import { allReady, bootstrapTools, toolsStore } from '@stores/tools'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import OnboardingView from '@views/onboarding/OnboardingView'
import CreateProjectModal from '@views/project/CreateProjectModal'
import ProjectView from '@views/project/ProjectView'
import SettingsModal from '@views/settings/SettingsModal'
import { Loader2 } from 'lucide-solid'
import {
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Component
} from 'solid-js'

/**
 * Root layout shell.
 *
 * Renders one of three exclusive views:
 *  1. Initial probe overlay — brief spinner while `bootstrapTools()` runs,
 *     so the Onboarding panel never flashes in front of stale empty state.
 *  2. Onboarding gate — full-window view when any `RequiredTool` is
 *     `Missing` or `Outdated`. Sidebar, drag-drop, and the bottom status
 *     bar are *not* rendered (per slice 0002 acceptance criteria); install
 *     buttons + live log panel land here (slice 0003).
 *  3. Normal three-region shell (Sidebar / Main / StatusBar). Slice 0004
 *     wires the project store: after Onboarding clears, `bootstrapActiveProject`
 *     auto-opens the most recent project (if any) and the Main region
 *     swaps `EmptyProjectsState` for `ProjectView`. The Create Project
 *     modal is mounted alongside Settings; `Ctrl+N` opens it from any
 *     post-Onboarding state.
 *
 * Global keyboard shortcuts boot regardless of gate state — Escape closes
 * any modal that registers itself in `modalStack`. The `Ctrl+N` binding
 * is owned by this component so it disposes cleanly during HMR.
 */
const AppShell: Component = () => {
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [createProjectOpen, setCreateProjectOpen] = createSignal(false)
  const [dragOverlayVisible, setDragOverlayVisible] = createSignal(false)

  onMount(() => {
    const dispose = installGlobalShortcuts()
    onCleanup(dispose)
    void bootstrapTools()
    // Bind backend job-event listeners once per app instance. Idempotent
    // — safe across Solid dev double-mount and HMR; events fired before
    // a project opens are scoped per-Episode so they no-op until the
    // jobs store has an `activeFolder` to attribute them to.
    void ensureJobSubscriptions()
  })

  // Once Onboarding clears, kick off the project bootstrap exactly once.
  // `createEffect(on(...))` keeps the trigger pure-Solid and disposes on
  // unmount; `bootstrapActiveProject` itself guards re-entry.
  createEffect(
    on(
      () => allReady(),
      ready => {
        if (ready) {
          void bootstrapActiveProject()
        }
      }
    )
  )

  // Bridge the projects store to the jobs store whenever the active
  // project changes: drop the per-Episode state from the previous
  // project (jobs, artifacts, don't-ask memory) and re-inspect the
  // disk for every Episode in the new one so each row's badge boots
  // with the correct "Trống" vs "Đã extract" derivation. Tracked by
  // (folder, episode count) so re-opening the same project or
  // appending Episodes both trigger the re-sync.
  createEffect(
    on(
      () => {
        const project = projectsStore.active
        const folder = projectsStore.activeFolder
        if (!project || !folder) return null
        return {
          folder,
          ids: project.episodes.map(e => e.id)
        }
      },
      snapshot => {
        if (!snapshot) return
        void setActiveProject(snapshot.folder, snapshot.ids)
      }
    )
  )

  // Tauri drag-drop subscription. The handler is bound once per AppShell
  // mount and ignores events whenever the project gate is not satisfied
  // (Onboarding running, or no Project open) so dragging files into the
  // app during Onboarding doesn't pop the overlay. The active-project
  // check is read live inside the callback rather than wired through a
  // Solid effect because the Tauri callback is not a reactive scope.
  createEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const u = await getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload
          const ready = allReady() && projectsStore.active !== null
          if (!ready) {
            // Make sure a stale overlay (e.g. user closed the project mid-
            // drag) clears immediately rather than getting stuck.
            if (dragOverlayVisible()) setDragOverlayVisible(false)
            return
          }
          switch (payload.type) {
            case 'enter':
            case 'over':
              if (!dragOverlayVisible()) setDragOverlayVisible(true)
              break
            case 'leave':
              setDragOverlayVisible(false)
              break
            case 'drop':
              setDragOverlayVisible(false)
              if (payload.paths.length > 0) {
                void addEpisodes(payload.paths)
              }
              break
          }
        })
        if (cancelled) {
          u()
          return
        }
        unlisten = u
      } catch (err) {
        // Subscription fails on the dev server when webview is not yet
        // available — log and move on; the next createEffect re-run will
        // retry. We deliberately don't surface this as a user-visible
        // toast because drag-drop is a quality-of-life feature, not a
        // gating one.
        console.error('Failed to bind drag-drop listener', err)
      }
    })()
    onCleanup(() => {
      cancelled = true
      if (unlisten) unlisten()
    })
  })

  useKeyboardShortcut(
    'Ctrl+N',
    event => {
      if (!allReady()) return
      event.preventDefault()
      setCreateProjectOpen(true)
    },
    'Tạo project mới'
  )

  return (
    <div class="flex h-screen w-screen flex-col bg-bg font-sans text-text">
      <Switch>
        <Match when={toolsStore.phase === 'initial'}>
          <InitialProbeOverlay />
        </Match>

        <Match when={!allReady()}>
          <OnboardingView />
        </Match>

        <Match when={allReady()}>
          <div class="flex min-h-0 flex-1">
            <Sidebar onCreateProject={() => setCreateProjectOpen(true)} />
            <main class="flex min-w-0 flex-1 flex-col overflow-auto">
              <Show
                when={projectsStore.active && projectsStore.activeFolder}
                fallback={<EmptyProjectsState />}
              >
                <ProjectView
                  project={projectsStore.active!}
                  folder={projectsStore.activeFolder!}
                />
              </Show>
            </main>
          </div>
          <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
          <SettingsModal open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
          <CreateProjectModal
            open={createProjectOpen()}
            onClose={() => setCreateProjectOpen(false)}
          />
          <DropOverlay
            visible={dragOverlayVisible()}
            onDismiss={() => setDragOverlayVisible(false)}
          />
        </Match>
      </Switch>
      <ToastStack />
    </div>
  )
}

const InitialProbeOverlay: Component = () => (
  <div class="flex h-full w-full items-center justify-center bg-bg px-12 py-16">
    <div class="flex flex-col items-center gap-4 text-text-muted">
      <Loader2 size={32} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
      <p class="font-mono text-sm tracking-wide">Đang kiểm tra môi trường...</p>
    </div>
  </div>
)

export default AppShell
