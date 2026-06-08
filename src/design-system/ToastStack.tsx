import { dismissToast, toastStore, type ToastTone } from '@lib/toast/toastStore'
import { AlertCircle, AlertTriangle, CheckCircle2, X } from 'lucide-solid'
import { For, type Component, type JSX } from 'solid-js'

/**
 * Top-right transient toast stack rendered by `AppShell`.
 *
 * Subscribes to the global `toastStore` so any page can push without
 * prop-drilling. Each card is a fully-rounded pill with a tonal
 * background tint (matching `StatusBadge.solid`) — no border-only
 * outlines per the rounded-flat refresh.
 *
 * `aria-live="assertive"` so screen readers announce errors
 * immediately — toasts are reserved for user-triggered events.
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
  accent: 'bg-accent-soft text-accent',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger'
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
        'pointer-events-auto flex max-w-md min-w-[280px] items-start gap-3 rounded-2xl border border-border bg-elevated px-5 py-4 text-sm'
      ].join(' ')}
    >
      <span
        class={[
          'mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full',
          toneClasses[props.tone]
        ].join(' ')}
      >
        {ToastIcon[props.tone]()}
      </span>
      <p class="flex-1 break-words text-text">{props.message}</p>
      <button
        type="button"
        onClick={() => props.onDismiss()}
        class="-mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-full border border-transparent text-text-muted transition-colors hover:bg-surface hover:text-text"
        aria-label="Đóng thông báo"
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}

export default ToastStack
