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

const RemoveEpisodeModal: Component<RemoveEpisodeModalProps> = props => {
  const [removing, setRemoving] = createSignal(false)

  const handleConfirm = async (): Promise<void> => {
    if (removing()) return
    setRemoving(true)
    try {
      await removeEpisode(props.episodeId)
      props.onClose()
    } catch {
      /* toast already surfaced */
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
          <Button variant="ghost" onClick={() => props.onClose()} disabled={removing()}>
            Hủy
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleConfirm()}
            disabled={removing()}
          >
            {removing() ? 'Đang xoá…' : 'Xoá Episode'}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3 pt-4">
        <p class="text-base text-text">
          Xoá Episode{' '}
          <span class="font-mono text-text">&quot;{props.episodeName}&quot;</span>?
        </p>
        <p class="text-sm leading-relaxed text-text-muted">
          EpisodeFolder và toàn bộ artifact bên trong sẽ bị xoá. File MKV gốc không bị
          đụng tới.
        </p>
      </div>
    </Modal>
  )
}

export default RemoveEpisodeModal
