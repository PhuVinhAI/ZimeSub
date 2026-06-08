import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { createEffect, createSignal, on, Show, type Component } from 'solid-js'

/**
 * Overwrite-confirm modal for re-extracting an Episode that already
 * has `<basename>.eng.ass` on disk — slice 0007 AC mandates this
 * gate to prevent accidental loss of a previously-edited extract.
 *
 * The checkbox ("Không hỏi lại cho Episode này") is session-only
 * (see JobsStore.dontAskOverwrite). Cross-session persistence would
 * be a schema change for a convenience flag; the AC doesn't ask for
 * it, and the cost of asking once per session per Episode is low.
 *
 * Mounted at the ProjectView root with `open={confirmEpisode() !== null}`
 * so a single modal instance handles whichever row currently needs it.
 * `onConfirm(rememberDontAsk)` flips the JobsStore "don't ask" memory
 * when `true` and immediately enqueues; `onCancel` just closes.
 */
interface ExtractConfirmModalProps {
  open: boolean
  episodeName: string
  /** User chose "Ghi đè" — `rememberDontAsk` mirrors the checkbox state. */
  onConfirm: (rememberDontAsk: boolean) => void
  /** User dismissed (Hủy / Escape / backdrop click). */
  onCancel: () => void
}

const ExtractConfirmModal: Component<ExtractConfirmModalProps> = props => {
  const [dontAsk, setDontAsk] = createSignal(false)

  // Reset the checkbox whenever the modal opens fresh so a previous
  // "checked" state doesn't bleed across Episode rows.
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
      <Button variant="secondary" onClick={() => props.onCancel()}>
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
      <div class="flex flex-col gap-5">
        <p class="text-sm text-text">
          Episode này đã có sẵn file <code class="font-mono">.eng.ass</code> trên đĩa.
          Tiếp tục sẽ ghi đè bản extract hiện có — mọi chỉnh sửa thủ công trên file này sẽ
          mất.
        </p>
        <Show when={props.episodeName.length > 0}>
          <p class="break-all border-2 border-border bg-bg px-3 py-2 font-mono text-xs text-text-muted">
            {props.episodeName}
          </p>
        </Show>
        <label class="flex cursor-pointer items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            class="h-4 w-4 cursor-pointer accent-accent"
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
