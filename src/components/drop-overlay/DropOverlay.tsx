import { popModal, pushModal } from '@lib/modal/modalStack'
import { FilePlus2 } from 'lucide-solid'
import { createEffect, onCleanup, Show, type Component } from 'solid-js'

/**
 * Full-window overlay shown while the user drags files into the app
 * window with a Project open (slice 0005).
 *
 * Spec from docs/style-guide.md § "Drag & drop":
 *   semi-opaque `bg` at 0.92 alpha + 3 px dashed `accent` border inset
 *   24 px + a large centered Vietnamese label.
 *
 * Visibility is driven entirely by `props.visible`, which AppShell
 * derives from the `getCurrentWebview().onDragDropEvent` callback —
 * `enter`/`over` flip it to true, `leave`/`drop` flip it to false. Esc
 * is handled here via the global modal stack so it integrates with the
 * existing `closeTopModal` shortcut: while visible, this component
 * registers an entry that closes the overlay; when the user presses
 * Esc, the same code path that closes a modal also closes this overlay.
 *
 * `pointer-events-none` keeps the overlay non-interactive — the OS
 * still owns the drag operation, so we never want to consume the drop
 * event ourselves. Esc dismissal goes through the keyboard registry,
 * not a click.
 */
interface DropOverlayProps {
  visible: boolean
  onDismiss: () => void
}

const DropOverlay: Component<DropOverlayProps> = props => {
  // While visible, push a closer onto the modal stack so the global
  // Escape shortcut (installed in `globalShortcuts.ts`) can dismiss the
  // overlay without us having to register a parallel Escape binding
  // (the registry's "latest registration wins" rule would otherwise
  // shadow modal Escape handlers — see modalStack docs).
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
          class="absolute border-[3px] border-dashed border-accent"
          style={{
            top: '24px',
            right: '24px',
            bottom: '24px',
            left: '24px'
          }}
          aria-hidden="true"
        />
        <div class="relative flex flex-col items-center gap-6 px-12 text-center">
          <FilePlus2 size={64} strokeWidth={1.5} class="text-accent" aria-hidden="true" />
          <p class="text-3xl font-semibold tracking-tight text-text">
            Thả file MKV vào đây để thêm Episode
          </p>
          <p class="font-mono text-xs tracking-[0.18em] text-text-muted">
            CHỈ CHẤP NHẬN .MKV · NHẤN ESC ĐỂ HỦY
          </p>
        </div>
      </div>
    </Show>
  )
}

export default DropOverlay
