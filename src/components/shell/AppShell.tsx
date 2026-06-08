import DropOverlay from '@components/drop-overlay/DropOverlay'
import EmptyProjectsState from '@components/shell/EmptyProjectsState'
import Sidebar from '@components/shell/Sidebar'
import StatusBar from '@components/shell/StatusBar'
import ToastStack from '@design-system/ToastStack'
import { installGlobalShortcuts } from '@lib/keyboard/globalShortcuts'
import { useKeyboardShortcut } from '@lib/keyboard/useKeyboardShortcut'
import { ensureJobSubscriptions, setActiveProject } from '@stores/jobs'
import { addEpisodes, bootstrapActiveProject, projectsStore } from '@stores/projects'
import { bootstrapSettings } from '@stores/settings'
import { allReady, bootstrapTools, toolsStore } from '@stores/tools'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import JobsPanel from '@views/jobs-panel/JobsPanel'
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
 * Root layout shell — Rounded Flat refresh.
 *
 * The shell renders one of three exclusive views:
 *  1. Initial probe overlay — brief spinner while `bootstrapTools()` runs.
 *  2. Onboarding gate — full-window wizard when any RequiredTool is
 *     `Missing` or `Outdated`. Sidebar + StatusBar are not rendered.
 *  3. Normal shell — three rounded surface cards arranged as
 *
 *        +-------+---------------------+
 *        | Side  |       Main          |
 *        | bar   |  (project / empty)  |
 *        +-------+---------------------+
 *        |          StatusBar          |
 *        +-----------------------------+
 *
 *     with 12px gutters between every card; the outer window padding
 *     wraps everything so the cards never bleed to the OS chrome.
 *
 * Global keyboard shortcuts boot regardless of gate state — Escape
 * closes any modal that registers itself in `modalStack`. `Ctrl+N`
 * is owned by this component so it disposes cleanly during HMR.
 */
const AppShell: Component = () => {
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [createProjectOpen, setCreateProjectOpen] = createSignal(false)
  const [jobsPanelOpen, setJobsPanelOpen] = createSignal(false)
  const [dragOverlayVisible, setDragOverlayVisible] = createSignal(false)

  onMount(() => {
    const dispose = installGlobalShortcuts()
    onCleanup(dispose)
    void bootstrapTools()
    void ensureJobSubscriptions()
    void bootstrapSettings()
  })

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

  createEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const u = await getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload
          const ready = allReady() && projectsStore.active !== null
          if (!ready) {
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
          <div class="flex min-h-0 flex-1 gap-3 p-3 pb-0">
            <Sidebar onCreateProject={() => setCreateProjectOpen(true)} />
            <main class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border bg-surface">
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
          <div class="p-3 pt-3">
            <StatusBar
              onOpenSettings={() => setSettingsOpen(true)}
              onToggleJobsPanel={() => setJobsPanelOpen(prev => !prev)}
              jobsPanelOpen={jobsPanelOpen()}
            />
          </div>
          <JobsPanel open={jobsPanelOpen()} onClose={() => setJobsPanelOpen(false)} />
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
    <div class="flex flex-col items-center gap-5 text-text-muted">
      <span class="flex h-16 w-16 items-center justify-center rounded-full border border-border bg-surface">
        <Loader2 size={28} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
      </span>
      <p class="font-mono text-xs tracking-[0.22em] uppercase">
        Đang kiểm tra môi trường
      </p>
    </div>
  </div>
)

export default AppShell
