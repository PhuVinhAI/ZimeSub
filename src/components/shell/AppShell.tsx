import EmptyProjectsState from '@components/shell/EmptyProjectsState'
import Sidebar from '@components/shell/Sidebar'
import StatusBar from '@components/shell/StatusBar'
import { installGlobalShortcuts } from '@lib/keyboard/globalShortcuts'
import { allReady, bootstrapTools, toolsStore } from '@stores/tools'
import OnboardingView from '@views/onboarding/OnboardingView'
import { Loader2 } from 'lucide-solid'
import { Match, Switch, onCleanup, onMount, type Component } from 'solid-js'

/**
 * Root layout shell.
 *
 * Renders one of three exclusive views:
 *  1. Initial probe overlay — brief spinner while `bootstrapTools()` runs,
 *     so the Onboarding panel never flashes in front of stale empty state.
 *  2. Onboarding gate — full-window view when any `RequiredTool` is
 *     `Missing` or `Outdated`. Sidebar, drag-drop, and the bottom status
 *     bar are *not* rendered (per slice 0002 acceptance criteria).
 *  3. Normal three-region shell (Sidebar / Main / StatusBar) from
 *     slice 0001, shown once all three tools report `Ready`.
 *
 * Global keyboard shortcuts boot regardless of gate state — Escape still
 * works to close any modal that might appear during Onboarding (none today,
 * but the modal stack is shared infrastructure).
 */
const AppShell: Component = () => {
  onMount(() => {
    const dispose = installGlobalShortcuts()
    onCleanup(dispose)
    void bootstrapTools()
  })

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
            <Sidebar />
            <main class="flex min-w-0 flex-1 flex-col overflow-auto">
              <EmptyProjectsState />
            </main>
          </div>
          <StatusBar />
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
