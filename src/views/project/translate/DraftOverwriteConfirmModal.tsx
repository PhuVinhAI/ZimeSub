import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { Show, type Component } from 'solid-js'

/**
 * Overwrite-confirm modal for the "Tạo file .ass.txt" button when
 * `<basename>.eng.ass.txt` already exists. Drafts are cheap to
 * regenerate so there's no "Không hỏi lại" checkbox.
 */
interface DraftOverwriteConfirmModalProps {
  open: boolean
  episodeName: string
  onConfirm: () => void
  onCancel: () => void
}

const DraftOverwriteConfirmModal: Component<DraftOverwriteConfirmModalProps> = props => {
  const filename = (): string => `${props.episodeName}.eng.ass.txt`

  const footer = (
    <>
      <Button variant="ghost" onClick={() => props.onCancel()}>
        <span>Hủy</span>
      </Button>
      <Button
        variant="primary"
        onClick={() => props.onConfirm()}
        aria-label="Ghi đè bản nháp hiện có"
      >
        <span>Ghi đè</span>
      </Button>
    </>
  )

  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title="Ghi đè bản nháp .ass.txt?"
      ariaLabel="Xác nhận ghi đè bản nháp dịch"
      footer={footer}
    >
      <div class="flex flex-col gap-5 pt-4">
        <p class="text-sm leading-relaxed text-text">
          Episode này đã có sẵn file <code class="font-mono">.eng.ass.txt</code>. Tiếp tục
          sẽ ghi đè nội dung hiện có bằng bản sao mới từ{' '}
          <code class="font-mono">.eng.ass</code>.
        </p>
        <Show when={props.episodeName.length > 0}>
          <p class="rounded-2xl border border-border bg-bg px-4 py-3 font-mono text-xs break-all text-text-muted">
            {filename()}
          </p>
        </Show>
      </div>
    </Modal>
  )
}

export default DraftOverwriteConfirmModal
