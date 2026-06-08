import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { createEffect, createSignal, on, Show, type Component } from 'solid-js'

/**
 * Overwrite-confirm modal for re-extracting an Episode whose
 * `<basename>.eng.ass` already exists on disk.
 *
 * The checkbox ("Không hỏi lại cho Episode này") is session-only —
 * persisting cross-session would require a schema change for a
 * convenience flag.
 */
interface ExtractConfirmModalProps {
  open: boolean
  episodeName: string
  onConfirm: (rememberDontAsk: boolean) => void
  onCancel: () => void
}

const ExtractConfirmModal: Component<ExtractConfirmModalProps> = props => {
  const [dontAsk, setDontAsk] = createSignal(false)

  createEffect(
    on(
      () => props.open,
      open => {
        if (open) setDontAsk(false)
      }
    )
  )

  const footer = (
    <>
      <Button variant="ghost" onClick={() => props.onCancel()}>
        <span>Hủy</span>
      </Button>
      <Button
        variant="primary"
        onClick={() => props.onConfirm(dontAsk())}
        aria-label="Ghi đè bản extract hiện có"
      >
        <span>Ghi đè</span>
      </Button>
    </>
  )

  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title="Ghi đè bản extract?"
      ariaLabel="Xác nhận ghi đè bản extract"
      footer={footer}
    >
      <div class="flex flex-col gap-5 pt-4">
        <p class="text-sm leading-relaxed text-text">
          Episode này đã có sẵn file <code class="font-mono">.eng.ass</code> trên đĩa.
          Tiếp tục sẽ ghi đè bản extract hiện có — mọi chỉnh sửa thủ công trên file này sẽ
          mất.
        </p>
        <Show when={props.episodeName.length > 0}>
          <p class="rounded-2xl border border-border bg-bg px-4 py-3 font-mono text-xs break-all text-text-muted">
            {props.episodeName}
          </p>
        </Show>
        <label class="flex cursor-pointer items-center gap-2.5 text-sm text-text">
          <input
            type="checkbox"
            class="h-4 w-4 cursor-pointer rounded accent-accent"
            checked={dontAsk()}
            onInput={e => setDontAsk(e.currentTarget.checked)}
            aria-label="Không hỏi lại cho Episode này"
          />
          <span>Không hỏi lại cho Episode này</span>
        </label>
      </div>
    </Modal>
  )
}

export default ExtractConfirmModal
