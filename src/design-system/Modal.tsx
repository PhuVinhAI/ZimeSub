import { useModal } from '@lib/modal/modalStack'
import { X } from 'lucide-solid'
import { Show, type Component, type JSX, type ParentProps } from 'solid-js'

/**
 * Rounded modal primitive.
 *
 * Wraps the content in a full-window backdrop (solid `bg` at 0.85 alpha
 * — no blur per style guide), and a large rounded surface card. The
 * card has NO sided dividers between header / body / footer — the
 * three regions are spaced with internal padding so the rounded
 * silhouette stays uninterrupted.
 *
 * The backdrop click dismisses, mirroring desktop conventions. The
 * modal registers itself in the modal stack so global `Escape` from
 * `installGlobalShortcuts` pops it without any extra wiring.
 */
interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  ariaLabel: string
  footer?: JSX.Element
  /**
   * Tailwind max-width utility for the modal card. Defaults to
   * `max-w-xl`; track-picker bumps this to `max-w-3xl` and the paste
   * modals to `max-w-4xl` so the columns fit.
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
      class="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 px-6 py-12"
      onClick={handleBackdrop}
      role="presentation"
    >
      <section
        class={[
          'flex max-h-full w-full flex-col overflow-hidden rounded-[32px] border border-border bg-surface',
          props.maxWidthClass ?? 'max-w-xl'
        ].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel}
      >
        <Show when={props.title}>
          {title => (
            <header class="flex items-center justify-between gap-4 px-7 pt-6 pb-3">
              <h2 class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
                {title()}
              </h2>
              <button
                type="button"
                onClick={() => props.onClose()}
                class="-mr-2 flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-text-muted transition-colors hover:border-border hover:bg-elevated hover:text-text"
                aria-label="Đóng"
              >
                <X size={18} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </header>
          )}
        </Show>

        <div class="flex-1 overflow-y-auto px-7 pb-6">{props.children}</div>

        <Show when={props.footer}>
          <footer class="flex items-center justify-end gap-3 bg-elevated px-7 py-4">
            {props.footer}
          </footer>
        </Show>
      </section>
    </div>
  )
}

export default Modal
