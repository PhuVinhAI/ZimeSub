import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { createEffect, createSignal, on, Show, type Component } from 'solid-js'

/**
 * Overwrite-confirm modal for re-extracting an Episode's audio when
 * `<basename>.<ext>` already exists on disk — slice 0009 AC mandates
 * this gate so a long QC-listen track isn't silently replaced.
 *
 * The checkbox ("Không hỏi lại cho Episode này") is session-only
 * (see JobsStore.dontAskAudioOverwrite). Independent of the subtitle
 * variant so the user can opt out of one without losing the other.
 *
 * Mounted at the ProjectView root with `open={confirmEpisode() !== null}`
 * so a single modal instance handles whichever row currently needs it.
 */
interface AudioOverwriteConfirmModalProps {
  open: boolean
  episodeName: string
  /** Configured codec extension (`mp3` / `aac` / `flac`) — surfaced in the
   *  modal body so the user knows which file would be replaced. */
  audioExtension: string
  /** User chose "Ghi đè" — `rememberDontAsk` mirrors the checkbox state. */
  onConfirm: (rememberDontAsk: boolean) => void
  /** User dismissed (Hủy / Escape / backdrop click). */
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
      <Button variant="secondary" onClick={() => props.onCancel()}>
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
      <div class="flex flex-col gap-5">
        <p class="text-sm text-text">
          Episode này đã có sẵn file audio trên đĩa. Tiếp tục sẽ ghi đè bản audio hiện có.
        </p>
        <Show when={props.episodeName.length > 0}>
          <p class="break-all border-2 border-border bg-bg px-3 py-2 font-mono text-xs text-text-muted">
            {filename()}
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

export default AudioOverwriteConfirmModal
