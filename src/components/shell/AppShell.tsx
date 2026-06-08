import EmptyProjectsState from '@components/shell/EmptyProjectsState'
import Sidebar from '@components/shell/Sidebar'
import StatusBar from '@components/shell/StatusBar'
import { installGlobalShortcuts } from '@lib/keyboard/globalShortcuts'
import { onCleanup, onMount, type Component } from 'solid-js'

/**
 * Root layout shell.
 *
 * Three-region layout per docs/style-guide.md:
 *  - Sidebar (left, 280px)
 *  - Main content area (flex-1)
 *  - StatusBar (bottom, 56px)
 *
 * Boots global keyboard shortcuts on mount.
 */
const AppShell: Component = () => {
  onMount(() => {
    const dispose = installGlobalShortcuts()
    onCleanup(dispose)
  })

  return (
    <div class="flex h-screen w-screen flex-col bg-bg font-sans text-text">
      <div class="flex min-h-0 flex-1">
        <Sidebar />
        <main class="flex min-w-0 flex-1 flex-col overflow-auto">
          <EmptyProjectsState />
        </main>
      </div>
      <StatusBar />
    </div>
  )
}

export default AppShell
