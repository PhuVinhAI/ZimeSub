import { popModal, pushModal } from '@lib/modal/modalStack'
import { FilePlus2 } from 'lucide-solid'
import { createEffect, onCleanup, Show, type Component } from 'solid-js'

/**
 * Full-window overlay shown while the user drags files into the app
 * window with a Project open.
 *
 * The Rounded Flat refresh keeps the dashed-border affordance from the
 * original style guide (it reads as "drop target" instantly) but
 * rounds the corners and centres a soft card with the call-to-action
 * so the overlay matches the rest of the inset shell language.
 *
 * Visibility is driven entirely by `props.visible`, which AppShell
 * derives from `getCurrentWebview().onDragDropEvent`. Esc is wired
 * through the modal stack so it integrates with the existing
 * `closeTopModal` shortcut.
 *
 * `pointer-events-none` keeps the overlay non-interactive — the OS
 * still owns the drag operation.
 */
interface DropOverlayProps {
  visible: boolean
  onDismiss: () => void
}

const DropOverlay: Component<DropOverlayProps> = props => {
  createEffect(() => {
    if (!props.visible) return
    const id = pushModal(() => props.onDismiss())
    onCleanup(() => popModal(id))
  })

  return (
    <Show when={props.visible}>
      <div
        class="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-bg/92"
        role="status"
        aria-live="polite"
        aria-label="Đang kéo file vào cửa sổ"
      >
        <div
          class="absolute inset-6 rounded-[40px] border-2 border-dashed border-accent"
          aria-hidden="true"
        />
        <div class="relative flex flex-col items-center gap-6 rounded-[32px] border border-border bg-surface px-12 py-10 text-center">
          <span
            class="flex h-20 w-20 items-center justify-center rounded-3xl bg-accent text-accent-on-accent"
            aria-hidden="true"
          >
            <FilePlus2 size={36} strokeWidth={1.5} />
          </span>
          <p class="text-3xl font-semibold tracking-tight text-text">
            Thả file MKV vào đây
          </p>
          <p class="font-mono text-[11px] tracking-[0.22em] text-text-muted uppercase">
            Chỉ chấp nhận .mkv · Nhấn Esc để hủy
          </p>
        </div>
      </div>
    </Show>
  )
}

export default DropOverlay
