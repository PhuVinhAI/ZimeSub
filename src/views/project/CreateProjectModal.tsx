import { projectInspectFolder, type FolderInspection } from '@api/projects'
import { pickFolder } from '@api/dialog'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { createNewProject, openProjectByPath } from '@stores/projects'
import { FolderOpen, Loader2 } from 'lucide-solid'
import { createSignal, Match, Show, Switch, type Component } from 'solid-js'

interface CreateProjectModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal opened by the Sidebar "Tạo project" CTA (slice 0004).
 *
 * Flow:
 *  1. User enters a project name (required, non-empty) and clicks
 *     "Chọn thư mục" — invokes the OS folder picker via
 *     `tauri-plugin-dialog`.
 *  2. Once a folder is selected, the backend inspects it and we route
 *     between three CTAs:
 *      - empty / non-existent → "Tạo project" (primary)
 *      - has zimesub.json     → "Mở project hiện có" (primary), with
 *        the existing project name previewed
 *      - non-empty, no json   → inline error, CTA disabled
 *  3. On submit, the store is updated and the modal closes.
 *
 * Strings are Vietnamese per PRD § "UI shell & language".
 */
const CreateProjectModal: Component<CreateProjectModalProps> = props => {
  const [name, setName] = createSignal('')
  const [folder, setFolder] = createSignal<string | null>(null)
  const [inspection, setInspection] = createSignal<FolderInspection | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  const [inspecting, setInspecting] = createSignal(false)

  const reset = (): void => {
    setName('')
    setFolder(null)
    setInspection(null)
    setSubmitting(false)
    setSubmitError(null)
    setInspecting(false)
  }

  const handleClose = (): void => {
    reset()
    props.onClose()
  }

  const handlePickFolder = async (): Promise<void> => {
    setSubmitError(null)
    const picked = await pickFolder('Chọn thư mục project')
    if (!picked) return
    setFolder(picked)
    setInspecting(true)
    try {
      const result = await projectInspectFolder(picked)
      setInspection(result)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
      setInspection(null)
    } finally {
      setInspecting(false)
    }
  }

  const isCreateMode = (): boolean => {
    const ins = inspection()
    if (!ins) return true
    return !ins.has_zimesub_json
  }

  const isFolderBlocked = (): boolean => {
    const ins = inspection()
    if (!ins) return false
    return ins.exists && !ins.is_empty && !ins.has_zimesub_json
  }

  const trimmedName = (): string => name().trim()

  const canSubmit = (): boolean => {
    if (submitting()) return false
    if (inspecting()) return false
    if (!folder()) return false
    if (isFolderBlocked()) return false
    if (isCreateMode() && trimmedName().length === 0) return false
    return true
  }

  const submitLabel = (): string => (isCreateMode() ? 'Tạo project' : 'Mở project hiện có')

  const handleSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const selected = folder()
    if (!selected) return
    if (!canSubmit()) return

    setSubmitting(true)
    setSubmitError(null)
    try {
      if (isCreateMode()) {
        await createNewProject(selected, trimmedName())
      } else {
        await openProjectByPath(selected)
      }
      reset()
      props.onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={handleClose}
      title="Tạo project mới"
      ariaLabel="Tạo project mới"
    >
      <form class="flex flex-col gap-5" onSubmit={e => void handleSubmit(e)}>
        <label class="flex flex-col gap-2">
          <span class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            TÊN PROJECT
          </span>
          <input
            type="text"
            value={
              !isCreateMode() && inspection()?.existing_project_name
                ? inspection()!.existing_project_name!
                : name()
            }
            disabled={!isCreateMode() || submitting()}
            onInput={e => setName(e.currentTarget.value)}
            placeholder="Ví dụ: Oi Tonbo 2nd Season"
            class="h-11 border-2 border-border bg-bg px-3 font-sans text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-70"
            aria-required="true"
          />
          <Show when={!isCreateMode()}>
            <p class="font-mono text-xs text-text-muted">
              Tên sẽ được đọc từ <span class="text-text">zimesub.json</span> trong thư mục.
            </p>
          </Show>
        </label>

        <div class="flex flex-col gap-2">
          <span class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            THƯ MỤC
          </span>
          <Button
            variant="secondary"
            onClick={() => void handlePickFolder()}
            disabled={submitting()}
            aria-label="Chọn thư mục project"
          >
            <FolderOpen size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>{folder() ? 'Chọn thư mục khác...' : 'Chọn thư mục'}</span>
          </Button>
          <Show when={folder()}>
            {f => (
              <p
                class="border-2 border-border bg-bg px-3 py-2 font-mono text-xs break-all text-text"
                aria-label="Đường dẫn thư mục đã chọn"
              >
                {f()}
              </p>
            )}
          </Show>
        </div>

        <Show when={inspecting()}>
          <p class="flex items-center gap-2 font-mono text-xs text-text-muted">
            <Loader2 size={14} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
            <span>Đang kiểm tra thư mục...</span>
          </p>
        </Show>

        <Show when={!inspecting() && inspection()}>
          {ins => (
            <Switch>
              <Match when={ins().has_zimesub_json}>
                <p
                  class="border-2 border-accent bg-bg px-3 py-2 text-xs text-accent"
                  role="status"
                >
                  Thư mục đã có project ZimeSub
                  <Show when={ins().existing_project_name}>
                    {n => <span class="text-text"> · {n()}</span>}
                  </Show>
                  . Nhấn "Mở project hiện có" để tiếp tục.
                </p>
              </Match>
              <Match when={ins().exists && !ins().is_empty && !ins().has_zimesub_json}>
                <p
                  class="border-2 border-danger bg-bg px-3 py-2 text-xs text-danger"
                  role="alert"
                >
                  Thư mục đã có file khác. Hãy chọn thư mục trống hoặc thư mục đã có{' '}
                  <span class="font-mono">zimesub.json</span>.
                </p>
              </Match>
              <Match when={!ins().exists}>
                <p
                  class="border-2 border-border bg-bg px-3 py-2 text-xs text-text-muted"
                  role="status"
                >
                  Thư mục chưa tồn tại — sẽ được tạo khi nhấn "Tạo project".
                </p>
              </Match>
              <Match when={ins().exists && ins().is_empty}>
                <p
                  class="border-2 border-border bg-bg px-3 py-2 text-xs text-text-muted"
                  role="status"
                >
                  Thư mục trống. Sẵn sàng để tạo project mới.
                </p>
              </Match>
            </Switch>
          )}
        </Show>

        <Show when={submitError()}>
          {err => (
            <p
              class="border-2 border-danger bg-bg px-3 py-2 text-xs text-danger"
              role="alert"
            >
              {err()}
            </p>
          )}
        </Show>

        <div class="flex items-center justify-end gap-3 border-t-2 border-border pt-4">
          <Button
            variant="secondary"
            type="button"
            onClick={handleClose}
            disabled={submitting()}
            aria-label="Hủy"
          >
            <span>Hủy</span>
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!canSubmit()}
            aria-label={submitLabel()}
          >
            <Show when={submitting()}>
              <Loader2 size={18} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
            </Show>
            <span>{submitting() ? 'Đang xử lý...' : submitLabel()}</span>
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export default CreateProjectModal
