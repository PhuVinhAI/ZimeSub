import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { createEffect, createSignal, on, Show, type Component } from 'solid-js'

/**
 * Overwrite-confirm modal for re-extracting an Episode's audio when
 * the configured codec's file already exists on disk.
 */
interface AudioOverwriteConfirmModalProps {
  open: boolean
  episodeName: string
  audioExtension: string
  onConfirm: (rememberDontAsk: boolean) => void
  onCancel: () => void
}

const AudioOverwriteConfirmModal: Component<AudioOverwriteConfirmModalProps> = props => {
  const [dontAsk, setDontAsk] = createSignal(false)

  createEffect(
    on(
      () => props.open,
      open => {
        if (open) setDontAsk(false)
      }
    )
  )

  const filename = (): string => `${props.episodeName}.${props.audioExtension || 'mp3'}`

  const footer = (
    <>
      <Button variant="ghost" onClick={() => props.onCancel()}>
        <span>Hủy</span>
      </Button>
      <Button
        variant="primary"
        onClick={() => props.onConfirm(dontAsk())}
        aria-label="Ghi đè audio hiện có"
      >
        <span>Ghi đè</span>
      </Button>
    </>
  )

  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title="Ghi đè audio hiện có?"
      ariaLabel="Xác nhận ghi đè audio"
      footer={footer}
    >
      <div class="flex flex-col gap-5 pt-4">
        <p class="text-sm leading-relaxed text-text">
          Episode này đã có sẵn file audio trên đĩa. Tiếp tục sẽ ghi đè bản audio hiện có.
        </p>
        <Show when={props.episodeName.length > 0}>
          <p class="rounded-2xl border border-border bg-bg px-4 py-3 font-mono text-xs break-all text-text-muted">
            {filename()}
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

export default AudioOverwriteConfirmModal
