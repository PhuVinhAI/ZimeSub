import { episodeWriteTranslated } from '@api/translate'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { pushAccentToast, pushDangerToast } from '@lib/toast/toastStore'
import { artifactStateFor, refreshArtifactsForEpisode } from '@stores/jobs'
import { createEffect, createSignal, on, Show, type Component } from 'solid-js'

/**
 * Paste-translation modal — "Dán bản dịch" button.
 *
 * Renders a large Geist Mono textarea (≥ 20 rows) the user pastes the
 * full translated ASS into; clicking "Lưu" writes it to
 * `<basename>.vietsub.ass`.
 *
 * Overwrite handling: the first save with `overwrite = false` shows
 * an in-modal yellow banner; "Ghi đè và lưu" then re-invokes with
 * `overwrite = true`.
 */
interface PasteTranslationModalProps {
  open: boolean
  episodeId: string
  episodeName: string
  folder: string
  onClose: () => void
}

const PasteTranslationModal: Component<PasteTranslationModalProps> = props => {
  const [content, setContent] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [showOverwriteBanner, setShowOverwriteBanner] = createSignal(false)

  createEffect(
    on(
      () => props.open,
      open => {
        if (open) {
          setContent('')
          setShowOverwriteBanner(false)
          setSaving(false)
        }
      }
    )
  )

  const targetFilename = (): string => `${props.episodeName}.vietsub.ass`

  const trySave = async (overwrite: boolean): Promise<void> => {
    const body = content()
    if (body.trim().length === 0) {
      pushDangerToast('Bản dịch trống — không có gì để lưu')
      return
    }
    setSaving(true)
    try {
      await episodeWriteTranslated(props.folder, props.episodeId, body, overwrite)
      await refreshArtifactsForEpisode(props.episodeId)
      pushAccentToast(overwrite ? 'Đã ghi đè vietsub.ass' : 'Đã lưu vietsub.ass')
      props.onClose()
    } catch (err) {
      const message = messageOf(err)
      if (message === 'TARGET_EXISTS') {
        setShowOverwriteBanner(true)
        return
      }
      pushDangerToast(`Không lưu được bản dịch: ${message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveClick = (): void => {
    void trySave(false)
  }

  const handleOverwriteClick = (): void => {
    void trySave(true)
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
      <Show
        when={showOverwriteBanner()}
        fallback={
          <Button
            variant="primary"
            onClick={handleSaveClick}
            disabled={saving()}
            aria-label="Lưu bản dịch thành .vietsub.ass"
          >
            <span>{saving() ? 'Đang lưu…' : 'Lưu'}</span>
          </Button>
        }
      >
        <Button
          variant="primary"
          onClick={handleOverwriteClick}
          disabled={saving()}
          aria-label="Ghi đè vietsub.ass và lưu bản dịch"
        >
          <span>{saving() ? 'Đang lưu…' : 'Ghi đè và lưu'}</span>
        </Button>
      </Show>
    </>
  )

  const charCount = (): number => content().length

  return (
    <Modal
      open={props.open}
      onClose={() => {
        if (saving()) return
        props.onClose()
      }}
      title="Dán bản dịch tiếng Việt"
      ariaLabel="Dán bản dịch ASS đầy đủ"
      footer={footer}
      maxWidthClass="max-w-4xl"
    >
      <div class="flex flex-col gap-4 pt-4">
        <p class="text-sm leading-relaxed text-text">
          Dán toàn bộ nội dung file ASS đã dịch vào ô bên dưới. Khi lưu, ZimeSub sẽ ghi
          file <code class="font-mono">{targetFilename()}</code> vào EpisodeFolder.
        </p>

        <Show
          when={
            showOverwriteBanner() && artifactStateFor(props.episodeId)?.hasTranslatedSub
          }
        >
          <div
            class="rounded-2xl border border-warn/40 bg-warn-soft px-4 py-3 font-mono text-xs text-warn"
            role="alert"
          >
            File <code>{targetFilename()}</code> đã tồn tại. Nhấn "Ghi đè và lưu" để thay
            thế.
          </div>
        </Show>

        <textarea
          class="block w-full resize-y rounded-2xl border border-border bg-bg px-4 py-3 font-mono text-xs leading-relaxed text-text outline-none focus:border-accent"
          rows={22}
          value={content()}
          onInput={e => {
            setContent(e.currentTarget.value)
            setShowOverwriteBanner(false)
          }}
          placeholder="[Script Info]&#10;Title: ..."
          aria-label="Nội dung ASS đã dịch"
          spellcheck={false}
        />

        <div class="flex items-center justify-between font-mono text-[10px] tracking-wide text-text-muted">
          <span>{charCount().toLocaleString('vi-VN')} ký tự</span>
          <span>UTF-8 · LF/CRLF tự động</span>
        </div>
      </div>
    </Modal>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default PasteTranslationModal
