import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import TerminalLog, { type TerminalLogLine } from '@design-system/TerminalLog'
import { createMemo, Show, type Component } from 'solid-js'

/**
 * Failure-modal for a finished extract-subtitle job. Opened by
 * clicking the red "Lỗi extract" badge on an Episode row; renders
 * the captured stderr verbatim via `TerminalLog` so the user can
 * read the underlying mkvextract complaint without digging into
 * `%APPDATA%\ZimeSub\logs\zimesub.log`.
 *
 * `stderr` is supplied via the JobsStore — backend ships the full
 * buffered text on the `job-done` event so the modal opens with no
 * additional IPC round-trip. The optional `errorMessage` adds a
 * Vietnamese summary line above the log when the backend included
 * one (spawn failure, post-extract conversion failure, etc.); on a
 * plain mkvextract non-zero exit the `exitCode` line below tells
 * the same story.
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
    <Button variant="secondary" onClick={() => props.onClose()}>
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
      <div class="flex flex-col gap-4">
        <Show when={props.episodeName.length > 0}>
          <header class="flex flex-col gap-1">
            <span class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
              EPISODE
            </span>
            <p class="break-all text-sm text-text">{props.episodeName}</p>
          </header>
        </Show>

        <p class="text-sm text-danger">
          mkvextract thất bại
          <Show when={props.exitCode !== null}>
            <span class="font-mono text-text-muted"> (exit {props.exitCode})</span>
          </Show>
          <Show when={props.errorMessage}>
            {msg => <span class="text-text-muted"> · {msg()}</span>}
          </Show>
        </p>

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
