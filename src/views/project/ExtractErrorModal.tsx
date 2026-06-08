import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import TerminalLog, { type TerminalLogLine } from '@design-system/TerminalLog'
import { createMemo, Show, type Component } from 'solid-js'

/**
 * Failure modal for a finished extract-subtitle job. Opened by
 * clicking the red "Lỗi extract" badge on an Episode row; renders
 * the captured stderr verbatim via `TerminalLog`.
 */
interface ExtractErrorModalProps {
  open: boolean
  onClose: () => void
  episodeName: string
  stderr: string
  errorMessage: string | null
  exitCode: number | null
}

const ExtractErrorModal: Component<ExtractErrorModalProps> = props => {
  const lines = createMemo<TerminalLogLine[]>(() => {
    return props.stderr
      .split(/\r?\n/)
      .filter(l => l.length > 0)
      .map(text => ({ stream: 'stderr' as const, text }))
  })

  const footer = (
    <Button variant="ghost" onClick={() => props.onClose()}>
      <span>Đóng</span>
    </Button>
  )

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Lỗi extract"
      ariaLabel="Chi tiết lỗi extract phụ đề"
      footer={footer}
      maxWidthClass="max-w-2xl"
    >
      <div class="flex flex-col gap-5 pt-4">
        <Show when={props.episodeName.length > 0}>
          <header class="flex flex-col gap-1.5">
            <span class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
              Episode
            </span>
            <p class="break-all text-sm text-text">{props.episodeName}</p>
          </header>
        </Show>

        <div class="rounded-2xl border border-danger/40 bg-danger-soft px-5 py-4">
          <p class="text-sm text-danger">
            mkvextract thất bại
            <Show when={props.exitCode !== null}>
              <span class="font-mono text-text-muted"> (exit {props.exitCode})</span>
            </Show>
            <Show when={props.errorMessage}>
              {msg => <span class="text-text-muted"> · {msg()}</span>}
            </Show>
          </p>
        </div>

        <TerminalLog
          lines={lines()}
          ariaLabel="Stderr mkvextract"
          emptyHint="mkvextract không trả về thông báo lỗi."
        />
      </div>
    </Modal>
  )
}

export default ExtractErrorModal
