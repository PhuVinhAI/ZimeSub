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
 * Rename project modal — opens from the ProjectView header.
 *
 * On submit the projects store runs the backend rename (folder rename +
 * `name` field) and updates activeFolder to point at the renamed
 * folder. If the OS rename fails (permission, in-use, collision) the
 * raw error surfaces inline and the modal stays open for retry.
 */
const RenameProjectModal: Component<RenameProjectModalProps> = props => {
  const [name, setName] = createSignal(props.currentName)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

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
          <Button variant="ghost" onClick={() => props.onClose()} disabled={saving()}>
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
      <div class="flex flex-col gap-4 pt-4">
        <p class="text-sm leading-relaxed text-text-muted">
          Đổi tên project sẽ đổi tên thư mục trên ổ đĩa và cập nhật{' '}
          <span class="font-mono text-text">zimesub.json</span>. Nếu hệ điều hành chặn
          việc đổi tên (file đang mở, không có quyền), file json sẽ không bị thay đổi.
        </p>
        <label class="flex flex-col gap-2">
          <span class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
            Tên mới
          </span>
          <input
            type="text"
            value={name()}
            onInput={e => setName(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && canSubmit()) void handleSubmit()
            }}
            disabled={saving()}
            class="h-12 rounded-2xl border border-border bg-bg px-4 text-base text-text outline-none focus:border-accent disabled:opacity-60"
            aria-label="Tên project mới"
            autofocus
          />
        </label>
        <Show when={error()}>
          <p class="rounded-2xl border border-danger/40 bg-danger-soft px-4 py-3 font-mono text-xs text-danger">
            {error()}
          </p>
        </Show>
      </div>
    </Modal>
  )
}

export default RenameProjectModal
