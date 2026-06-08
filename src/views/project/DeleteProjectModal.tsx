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
 * Slice 0012 — strong two-step confirm modal for deleting a project.
 *
 * Lists what will be deleted (ProjectFolder content) and what will
 * NOT (SourceMkv files outside it). The destructive button stays
 * disabled until the user types the project name verbatim into the
 * confirmation field — defends against muscle-memory mis-clicks.
 *
 * Backend cancels every in-flight job belonging to this project
 * before recursively removing the folder; the recents MRU is
 * refreshed so the deleted project disappears from the Sidebar.
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
      // Store already surfaced the toast; keep modal open so the user
      // can retry after fixing the underlying issue.
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
          <Button
            variant="secondary"
            onClick={() => props.onClose()}
            disabled={deleting()}
          >
            Hủy
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={!canDelete()}
            class="border-danger bg-danger text-bg hover:border-danger hover:bg-bg hover:text-danger disabled:border-border disabled:bg-border disabled:text-text-muted"
          >
            {deleting() ? 'Đang xoá…' : 'Xoá vĩnh viễn'}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <p class="text-base text-text">
          Bạn sắp xoá vĩnh viễn project{' '}
          <span class="font-mono text-text">&quot;{props.projectName}&quot;</span>.
        </p>
        <div class="border-2 border-danger bg-bg px-3 py-3">
          <p class="font-mono text-xs font-semibold tracking-[0.18em] text-danger uppercase">
            SẼ BỊ XOÁ
          </p>
          <ul class="mt-2 list-disc pl-5 text-sm text-text">
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
        <div class="border-2 border-accent bg-bg px-3 py-3">
          <p class="font-mono text-xs font-semibold tracking-[0.18em] text-accent uppercase">
            KHÔNG BỊ XOÁ
          </p>
          <ul class="mt-2 list-disc pl-5 text-sm text-text">
            <li>File MKV gốc nằm ngoài thư mục project (ADR-0001).</li>
            <li>Cấu hình app-level và lịch sử log.</li>
          </ul>
        </div>
        <label class="flex flex-col gap-1">
          <span class="font-mono text-xs font-medium text-text">
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
            class="h-11 border-2 border-border bg-bg px-3 font-mono text-base text-text outline-none focus:border-danger disabled:opacity-60"
            aria-label="Nhập tên project để xác nhận xoá"
            autofocus
          />
        </label>
      </div>
    </Modal>
  )
}

export default DeleteProjectModal
