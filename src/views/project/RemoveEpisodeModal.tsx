import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { removeEpisode } from '@stores/projects'
import { createSignal, type Component } from 'solid-js'

interface RemoveEpisodeModalProps {
  open: boolean
  episodeName: string
  episodeId: string
  onClose: () => void
}

/**
 * Slice 0012 — confirm modal for removing one Episode.
 *
 * The PRD AC string verbatim: "Xoá Episode '<folder_name>'?
 * EpisodeFolder và toàn bộ artifact bên trong sẽ bị xoá. File MKV
 * gốc không bị đụng tới."
 *
 * The destructive button is the only path forward; cancelling
 * closes the modal with no side effects. Backend cancels in-flight
 * jobs for this Episode before deleting the folder.
 */
const RemoveEpisodeModal: Component<RemoveEpisodeModalProps> = props => {
  const [removing, setRemoving] = createSignal(false)

  const handleConfirm = async (): Promise<void> => {
    if (removing()) return
    setRemoving(true)
    try {
      await removeEpisode(props.episodeId)
      props.onClose()
    } catch {
      // Store already surfaced the toast.
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={() => (removing() ? undefined : props.onClose())}
      title="Xoá Episode"
      ariaLabel="Xác nhận xoá Episode"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => props.onClose()}
            disabled={removing()}
          >
            Hủy
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={removing()}
            class="border-danger bg-danger text-bg hover:border-danger hover:bg-bg hover:text-danger"
          >
            {removing() ? 'Đang xoá…' : 'Xoá Episode'}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <p class="text-base text-text">
          Xoá Episode{' '}
          <span class="font-mono text-text">&quot;{props.episodeName}&quot;</span>?
        </p>
        <p class="text-sm text-text-muted">
          EpisodeFolder và toàn bộ artifact bên trong sẽ bị xoá. File MKV gốc không bị
          đụng tới.
        </p>
      </div>
    </Modal>
  )
}

export default RemoveEpisodeModal
