import { useModal } from '@lib/modal/modalStack'
import { X } from 'lucide-solid'
import { Show, type Component, type JSX, type ParentProps } from 'solid-js'

/**
 * Minimal centered modal primitive.
 *
 * Wraps the content in a full-window backdrop (solid `bg`, no blur — flat
 * dark style guide), a 2px-border surface card, and an optional title bar
 * with a close button. Registers itself in the modal stack so the global
 * `Escape` shortcut from `installGlobalShortcuts` pops it for free.
 *
 * The backdrop click also dismisses — same behaviour as most desktop apps.
 * Use the `aria-label` on the modal section so screen readers announce it
 * when focus enters.
 */
interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  ariaLabel: string
  footer?: JSX.Element
  /**
   * Tailwind max-width utility for the modal card. Defaults to
   * `max-w-xl`. Slice 0006's track-picker bumps this to `max-w-3xl`
   * to fit the columns (track id / language / codec / title / flags)
   * without sideways scrolling on the 1024 px minimum window width.
   */
  maxWidthClass?: string
}

const Modal: Component<ParentProps<ModalProps>> = props => {
  return (
    <Show when={props.open}>
      <ModalInner
        onClose={props.onClose}
        title={props.title}
        ariaLabel={props.ariaLabel}
        footer={props.footer}
        maxWidthClass={props.maxWidthClass}
      >
        {props.children}
      </ModalInner>
    </Show>
  )
}

const ModalInner: Component<ParentProps<Omit<ModalProps, 'open'>>> = props => {
  useModal(() => props.onClose())

  const handleBackdrop = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-bg/92 px-6 py-12"
      onClick={handleBackdrop}
      role="presentation"
    >
      <section
        class={[
          'flex max-h-full w-full flex-col border-2 border-border bg-surface',
          props.maxWidthClass ?? 'max-w-xl'
        ].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel}
      >
        <Show when={props.title}>
          {title => (
            <header class="flex items-center justify-between gap-4 border-b-2 border-border px-6 py-4">
              <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text">
                {title().toUpperCase()}
              </h2>
              <button
                type="button"
                onClick={() => props.onClose()}
                class="-mr-2 flex h-9 w-9 items-center justify-center border-2 border-transparent text-text-muted transition-colors hover:border-border hover:text-text"
                aria-label="Đóng"
              >
                <X size={18} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </header>
          )}
        </Show>

        <div class="flex-1 overflow-y-auto px-6 py-5">{props.children}</div>

        <Show when={props.footer}>
          <footer class="flex items-center justify-end gap-3 border-t-2 border-border px-6 py-4">
            {props.footer}
          </footer>
        </Show>
      </section>
    </div>
  )
}

export default Modal
