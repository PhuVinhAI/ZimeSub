import EmptyProjectsState from '@components/shell/EmptyProjectsState'
import Sidebar from '@components/shell/Sidebar'
import StatusBar from '@components/shell/StatusBar'
import { installGlobalShortcuts } from '@lib/keyboard/globalShortcuts'
import { useKeyboardShortcut } from '@lib/keyboard/useKeyboardShortcut'
import { bootstrapActiveProject, projectsStore } from '@stores/projects'
import { allReady, bootstrapTools, toolsStore } from '@stores/tools'
import CreateProjectModal from '@views/project/CreateProjectModal'
import ProjectView from '@views/project/ProjectView'
import OnboardingView from '@views/onboarding/OnboardingView'
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

  onMount(() => {
    const dispose = installGlobalShortcuts()
    onCleanup(dispose)
    void bootstrapTools()
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
        </Match>
      </Switch>
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
