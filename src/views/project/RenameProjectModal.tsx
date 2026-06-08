import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { renameActiveProject } from '@stores/projects'
import { createEffect, createSignal, on, Show, type Component } from 'solid-js'

interface RenameProjectModalProps {
  open: boolean
  currentName: string
  onClose: () => void
}

/**
 * Slice 0012 — rename project modal.
 *
 * Opens from the project view header's "Đổi tên" button. The text
 * field boots with the current name; on submit the projects store
 * runs the backend rename (folder rename + json `name` field) and
 * the activeFolder is updated to point at the renamed folder. If the
 * folder rename fails (permission, in-use, destination collision)
 * the error toast surfaces the raw OS message and the modal stays
 * open so the user can adjust the name and retry.
 */
const RenameProjectModal: Component<RenameProjectModalProps> = props => {
  const [name, setName] = createSignal(props.currentName)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Re-seed the input every time the modal opens so a stale previous
  // attempt doesn't bleed into the next launch.
  createEffect(
    on(
      () => props.open,
      open => {
        if (open) {
          setName(props.currentName)
          setError(null)
          setSaving(false)
        }
      }
    )
  )

  const canSubmit = (): boolean => {
    const trimmed = name().trim()
    return trimmed.length > 0 && trimmed !== props.currentName && !saving()
  }

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit()) return
    setSaving(true)
    setError(null)
    try {
      await renameActiveProject(name().trim())
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={() => (saving() ? undefined : props.onClose())}
      title="Đổi tên project"
      ariaLabel="Đổi tên project"
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onClose()} disabled={saving()}>
            Hủy
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit()}
          >
            {saving() ? 'Đang lưu…' : 'Lưu'}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <p class="text-sm text-text-muted">
          Đổi tên project sẽ đổi tên thư mục trên ổ đĩa và cập nhật{' '}
          <span class="font-mono text-text">zimesub.json</span>. Nếu hệ điều hành chặn
          việc đổi tên (file đang mở, không có quyền), file json sẽ không bị thay đổi.
        </p>
        <label class="flex flex-col gap-1">
          <span class="font-mono text-xs font-medium text-text">Tên mới</span>
          <input
            type="text"
            value={name()}
            onInput={e => setName(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && canSubmit()) void handleSubmit()
            }}
            disabled={saving()}
            class="h-11 border-2 border-border bg-bg px-3 text-base text-text outline-none focus:border-accent disabled:opacity-60"
            aria-label="Tên project mới"
            autofocus
          />
        </label>
        <Show when={error()}>
          <p class="border-2 border-danger bg-bg px-3 py-2 font-mono text-xs text-danger">
            {error()}
          </p>
        </Show>
      </div>
    </Modal>
  )
}

export default RenameProjectModal
