import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { deleteActiveProject } from '@stores/projects'
import { createEffect, createSignal, on, type Component } from 'solid-js'

interface DeleteProjectModalProps {
  open: boolean
  projectName: string
  folder: string
  onClose: () => void
}

/**
 * Strong two-step confirm modal for deleting a project.
 *
 * Lists what will be deleted (ProjectFolder content) and what will
 * NOT (SourceMkv files outside it). The destructive button stays
 * disabled until the user types the project name verbatim into the
 * confirmation field — defends against muscle-memory mis-clicks.
 */
const DeleteProjectModal: Component<DeleteProjectModalProps> = props => {
  const [confirmation, setConfirmation] = createSignal('')
  const [deleting, setDeleting] = createSignal(false)

  createEffect(
    on(
      () => props.open,
      open => {
        if (open) {
          setConfirmation('')
          setDeleting(false)
        }
      }
    )
  )

  const canDelete = (): boolean =>
    confirmation().trim() === props.projectName && !deleting()

  const handleConfirm = async (): Promise<void> => {
    if (!canDelete()) return
    setDeleting(true)
    try {
      await deleteActiveProject()
      props.onClose()
    } catch {
      /* toast already surfaced */
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={() => (deleting() ? undefined : props.onClose())}
      title="Xoá project"
      ariaLabel="Xác nhận xoá project"
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()} disabled={deleting()}>
            Hủy
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleConfirm()}
            disabled={!canDelete()}
          >
            {deleting() ? 'Đang xoá…' : 'Xoá vĩnh viễn'}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-4 pt-4">
        <p class="text-base text-text">
          Bạn sắp xoá vĩnh viễn project{' '}
          <span class="font-mono text-text">&quot;{props.projectName}&quot;</span>.
        </p>
        <div class="rounded-2xl border border-danger/40 bg-danger-soft px-5 py-4">
          <p class="font-mono text-[10px] font-semibold tracking-[0.22em] text-danger uppercase">
            Sẽ bị xoá
          </p>
          <ul class="mt-2 list-disc pl-5 text-sm leading-relaxed text-text">
            <li>
              Toàn bộ nội dung trong thư mục{' '}
              <span class="font-mono text-text-muted">{props.folder}</span>
            </li>
            <li>
              File <span class="font-mono text-text-muted">zimesub.json</span>, các
              EpisodeFolder và mọi artifact (.ass, .mp3, .mp4, …)
            </li>
            <li>Entry tương ứng trong danh sách Project gần đây</li>
          </ul>
        </div>
        <div class="rounded-2xl border border-accent/40 bg-accent-soft px-5 py-4">
          <p class="font-mono text-[10px] font-semibold tracking-[0.22em] text-accent uppercase">
            Không bị xoá
          </p>
          <ul class="mt-2 list-disc pl-5 text-sm leading-relaxed text-text">
            <li>File MKV gốc nằm ngoài thư mục project (ADR-0001).</li>
            <li>Cấu hình app-level và lịch sử log.</li>
          </ul>
        </div>
        <label class="flex flex-col gap-2">
          <span class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
            Gõ tên project để xác nhận:{' '}
            <span class="text-accent">{props.projectName}</span>
          </span>
          <input
            type="text"
            value={confirmation()}
            onInput={e => setConfirmation(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && canDelete()) void handleConfirm()
            }}
            disabled={deleting()}
            class="h-12 rounded-2xl border border-border bg-bg px-4 font-mono text-base text-text outline-none focus:border-danger disabled:opacity-60"
            aria-label="Nhập tên project để xác nhận xoá"
            autofocus
          />
        </label>
      </div>
    </Modal>
  )
}

export default DeleteProjectModal
