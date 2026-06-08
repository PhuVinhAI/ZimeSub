import { episodeStylePatch } from '@api/translate'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { pushAccentToast, pushDangerToast } from '@lib/toast/toastStore'
import { refreshArtifactsForEpisode } from '@stores/jobs'
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  Show,
  type Component
} from 'solid-js'

/**
 * Paste-styles modal — "Dán [V4+ Styles]" button.
 *
 * Validates the paste matches the backend's `validate_styles_block`
 * check: must contain a `[V4+ Styles]` header line and a `Format:`
 * line right after it. The "Áp dụng" button is disabled until both
 * checks pass and the inline banner explains why.
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
        variant="ghost"
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
      <div class="flex flex-col gap-4 pt-4">
        <p class="text-sm leading-relaxed text-text">
          Dán nội dung section <code class="font-mono">[V4+ Styles]</code> đã chỉnh sửa từ
          Aegisub/AI. ZimeSub sẽ thay thế đúng section này trong
          <code class="ml-1 font-mono">{targetFilename()}</code> và giữ nguyên các section
          khác.
        </p>

        <Show when={showError()}>
          <div
            class="rounded-2xl border border-danger/40 bg-danger-soft px-4 py-3 font-mono text-xs text-danger"
            role="alert"
          >
            {errorMessage()}
          </div>
        </Show>

        <textarea
          class="block w-full resize-y rounded-2xl border border-border bg-bg px-4 py-3 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent"
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
