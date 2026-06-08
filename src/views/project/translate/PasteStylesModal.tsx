import { episodeStylePatch } from '@api/translate'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { pushAccentToast, pushDangerToast } from '@lib/toast/toastStore'
import { refreshArtifactsForEpisode } from '@stores/jobs'
import { createEffect, createMemo, createSignal, on, Show, type Component } from 'solid-js'

/**
 * Paste-styles modal — "Dán [V4+ Styles]" button. Slice 0010 AC 4.
 *
 * Renders a Geist Mono textarea for the user to paste a fresh
 * `[V4+ Styles]` block. Client-side validation matches the backend's
 * [`validate_styles_block`] check exactly:
 *  - The pasted text must contain a line that, after trimming, equals
 *    `[V4+ Styles]` (case-sensitive).
 *  - The next non-blank line after that header must start with
 *    `Format:`.
 *
 * The "Áp dụng" button is disabled until both checks pass; the inline
 * banner explains *why* the button is disabled so the user can fix
 * the input without trial-and-error. On save, the backend swaps the
 * `[V4+ Styles]` section of `<basename>.vietsub.ass` in-place and
 * leaves every other section untouched.
 */
interface PasteStylesModalProps {
  open: boolean
  episodeId: string
  episodeName: string
  folder: string
  onClose: () => void
}

type ValidationVerdict =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'missingHeader' | 'missingFormat' }

function validate(input: string): ValidationVerdict {
  if (input.trim().length === 0) {
    return { ok: false, reason: 'empty' }
  }
  const lines = input.split(/\r?\n/)
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[V4+ Styles]') {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: 'missingHeader' }
  }
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.length === 0) continue
    if (lines[i].trimStart().startsWith('Format:')) {
      return { ok: true }
    }
    return { ok: false, reason: 'missingFormat' }
  }
  return { ok: false, reason: 'missingFormat' }
}

const PasteStylesModal: Component<PasteStylesModalProps> = props => {
  const [content, setContent] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  /** True only after the user has interacted with the textarea — keeps
   *  the validation banner from screaming on a freshly-opened modal. */
  const [touched, setTouched] = createSignal(false)

  createEffect(
    on(
      () => props.open,
      open => {
        if (open) {
          setContent('')
          setSaving(false)
          setTouched(false)
        }
      }
    )
  )

  const verdict = createMemo<ValidationVerdict>(() => validate(content()))

  const targetFilename = (): string => `${props.episodeName}.vietsub.ass`

  const handleSave = async (): Promise<void> => {
    if (!verdict().ok) return
    setSaving(true)
    try {
      await episodeStylePatch(props.folder, props.episodeId, content())
      await refreshArtifactsForEpisode(props.episodeId)
      pushAccentToast('Đã thay [V4+ Styles] trong vietsub.ass')
      props.onClose()
    } catch (err) {
      const message = messageOf(err)
      if (message === 'NO_TRANSLATED_SUB') {
        pushDangerToast('Cần có bản dịch trước (vietsub.ass)')
      } else {
        pushDangerToast(`Không patch được styles: ${message}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const footer = (
    <>
      <Button
        variant="secondary"
        onClick={() => props.onClose()}
        disabled={saving()}
        aria-label="Đóng và hủy bản dán"
      >
        <span>Hủy</span>
      </Button>
      <Button
        variant="primary"
        onClick={() => void handleSave()}
        disabled={!verdict().ok || saving()}
        aria-label="Áp dụng [V4+ Styles] mới"
      >
        <span>{saving() ? 'Đang lưu…' : 'Áp dụng'}</span>
      </Button>
    </>
  )

  const showError = (): boolean => touched() && !verdict().ok
  const errorMessage = (): string => {
    const v = verdict()
    if (v.ok) return ''
    switch (v.reason) {
      case 'empty':
        return 'Khối dán trống — chưa có nội dung [V4+ Styles] để patch.'
      case 'missingHeader':
        return 'Khối dán phải chứa dòng [V4+ Styles] (chính xác, phân biệt hoa thường).'
      case 'missingFormat':
        return 'Sau [V4+ Styles] cần một dòng bắt đầu bằng Format: ... để mô tả các cột.'
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={() => {
        if (saving()) return
        props.onClose()
      }}
      title="Dán [V4+ Styles] để patch"
      ariaLabel="Dán nội dung section [V4+ Styles]"
      footer={footer}
      maxWidthClass="max-w-3xl"
    >
      <div class="flex flex-col gap-4">
        <p class="text-sm text-text">
          Dán nội dung section <code class="font-mono">[V4+ Styles]</code> đã chỉnh sửa
          từ Aegisub/AI. ZimeSub sẽ thay thế đúng section này trong
          <code class="ml-1 font-mono">{targetFilename()}</code> và giữ nguyên các
          section khác.
        </p>

        <Show when={showError()}>
          <div
            class="border-2 border-danger bg-bg px-3 py-2 font-mono text-xs text-danger"
            role="alert"
          >
            {errorMessage()}
          </div>
        </Show>

        <textarea
          class="block w-full resize-y border-2 border-border bg-bg px-3 py-2 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent"
          rows={16}
          value={content()}
          onInput={e => {
            setContent(e.currentTarget.value)
            setTouched(true)
          }}
          placeholder="[V4+ Styles]&#10;Format: Name, Fontname, Fontsize, ...&#10;Style: Default,Arial,48,..."
          aria-label="Khối [V4+ Styles] mới"
          spellcheck={false}
        />
      </div>
    </Modal>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default PasteStylesModal
