import { dismissToast, toastStore, type ToastTone } from '@lib/toast/toastStore'
import { AlertCircle, AlertTriangle, CheckCircle2, X } from 'lucide-solid'
import { For, type Component, type JSX } from 'solid-js'

/**
 * Top-right transient toast stack rendered by `AppShell`.
 *
 * Subscribes to the global `toastStore` — there is no prop interface
 * because every page can push without prop-drilling. Each card has a
 * 2 px tone-coloured border (matches `StatusBadge` tones), an icon, the
 * message, and a manual dismiss button. Auto-dismiss is handled by the
 * store; the X button calls `dismissToast(id)` for impatient users.
 *
 * `aria-live="assertive"` so screen readers announce errors immediately
 * — toasts in this app are reserved for the user's own actions ("file
 * rejected", "duplicate"), not background events.
 */
const ToastStack: Component = () => {
  return (
    <div
      class="pointer-events-none fixed inset-0 z-[60] flex flex-col items-end gap-3 px-6 py-6"
      aria-live="assertive"
      aria-atomic="false"
      aria-label="Thông báo"
    >
      <For each={toastStore.entries}>
        {entry => (
          <ToastCard
            tone={entry.tone}
            message={entry.message}
            onDismiss={() => dismissToast(entry.id)}
          />
        )}
      </For>
    </div>
  )
}

interface ToastCardProps {
  tone: ToastTone
  message: string
  onDismiss: () => void
}

const toneClasses: Record<ToastTone, string> = {
  accent: 'border-accent text-accent',
  warn: 'border-warn text-warn',
  danger: 'border-danger text-danger'
}

const ToastIcon: Record<ToastTone, () => JSX.Element> = {
  accent: () => <CheckCircle2 size={18} strokeWidth={1.5} aria-hidden="true" />,
  warn: () => <AlertTriangle size={18} strokeWidth={1.5} aria-hidden="true" />,
  danger: () => <AlertCircle size={18} strokeWidth={1.5} aria-hidden="true" />
}

const ToastCard: Component<ToastCardProps> = props => {
  return (
    <div
      role="status"
      class={[
        'pointer-events-auto flex max-w-md min-w-[260px] items-start gap-3 border-2 bg-surface px-4 py-3 text-sm',
        toneClasses[props.tone]
      ].join(' ')}
    >
      <span class="mt-0.5 flex-none">{ToastIcon[props.tone]()}</span>
      <p class="flex-1 break-words text-text">{props.message}</p>
      <button
        type="button"
        onClick={() => props.onDismiss()}
        class="-mr-1 flex h-7 w-7 flex-none items-center justify-center border-2 border-transparent text-text-muted transition-colors hover:border-border hover:text-text"
        aria-label="Đóng thông báo"
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}

export default ToastStack
