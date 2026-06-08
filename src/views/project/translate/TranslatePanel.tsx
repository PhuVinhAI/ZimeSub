import { episodeMakeTranslationDraft, episodeOpenFolder } from '@api/translate'
import Button from '@design-system/Button'
import StatusBadge from '@design-system/StatusBadge'
import { pushAccentToast, pushDangerToast } from '@lib/toast/toastStore'
import {
  artifactStateFor,
  refreshArtifactsForEpisode,
  type EpisodeArtifactState
} from '@stores/jobs'
import { projectsStore } from '@stores/projects'
import DraftOverwriteConfirmModal from '@views/project/translate/DraftOverwriteConfirmModal'
import PasteStylesModal from '@views/project/translate/PasteStylesModal'
import PasteTranslationModal from '@views/project/translate/PasteTranslationModal'
import { ClipboardPaste, FileText, FolderOpen, Palette } from 'lucide-solid'
import { createSignal, Show, type Component } from 'solid-js'

interface TranslatePanelProps {
  episodeId: string
  episodeName: string
}

/**
 * Per-Episode Translate stage panel — Rounded Flat refresh.
 *
 * The original `border-t-2` divider is replaced by an own rounded
 * surface card so the translate cluster reads as a distinct step in
 * the per-Episode wizard without resorting to single-side borders.
 */
const TranslatePanel: Component<TranslatePanelProps> = props => {
  const [draftConfirmOpen, setDraftConfirmOpen] = createSignal(false)
  const [pasteTranslationOpen, setPasteTranslationOpen] = createSignal(false)
  const [pasteStylesOpen, setPasteStylesOpen] = createSignal(false)

  const folder = (): string => projectsStore.activeFolder ?? ''
  const artifacts = (): EpisodeArtifactState | null => artifactStateFor(props.episodeId)
  const hasTranslated = (): boolean => artifacts()?.hasTranslatedSub ?? false
  const isRenderStale = (): boolean => artifacts()?.isRenderStale ?? false

  const handleOpenFolder = async (): Promise<void> => {
    try {
      await episodeOpenFolder(folder(), props.episodeId)
    } catch (err) {
      pushDangerToast(`Không mở được thư mục: ${messageOf(err)}`)
    }
  }

  const handleMakeDraft = async (): Promise<void> => {
    if (artifacts()?.hasTranslationDraft) {
      setDraftConfirmOpen(true)
      return
    }
    await runMakeDraft(false)
  }

  const runMakeDraft = async (overwrite: boolean): Promise<void> => {
    try {
      const outcome = await episodeMakeTranslationDraft(
        folder(),
        props.episodeId,
        overwrite
      )
      await refreshArtifactsForEpisode(props.episodeId)
      pushAccentToast(
        outcome.existed_before
          ? 'Đã ghi đè bản nháp .ass.txt'
          : 'Đã tạo bản nháp .ass.txt'
      )
    } catch (err) {
      const message = messageOf(err)
      if (message === 'TARGET_EXISTS') {
        setDraftConfirmOpen(true)
        return
      }
      pushDangerToast(`Không tạo được bản nháp: ${message}`)
    }
  }

  const handleDraftOverwriteConfirm = async (): Promise<void> => {
    setDraftConfirmOpen(false)
    await runMakeDraft(true)
  }

  return (
    <div
      class="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5"
      aria-label="Khu vực dịch thuật"
    >
      <div class="flex items-center justify-between gap-3">
        <span class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
          Dịch thuật
        </span>
        <Show when={isRenderStale()}>
          <StatusBadge tone="warn">Render lỗi thời</StatusBadge>
        </Show>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleOpenFolder()}
          aria-label="Mở EpisodeFolder trong Windows Explorer"
        >
          <FolderOpen size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Mở thư mục</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleMakeDraft()}
          aria-label="Tạo file .ass.txt từ .eng.ass"
        >
          <FileText size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Tạo .ass.txt</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPasteTranslationOpen(true)}
          aria-label="Dán bản dịch tiếng Việt"
        >
          <ClipboardPaste size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Dán bản dịch</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPasteStylesOpen(true)}
          disabled={!hasTranslated()}
          title={hasTranslated() ? undefined : 'Cần có bản dịch trước'}
          aria-label="Dán section [V4+ Styles] để patch"
        >
          <Palette size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Dán [V4+ Styles]</span>
        </Button>
      </div>

      <DraftOverwriteConfirmModal
        open={draftConfirmOpen()}
        episodeName={props.episodeName}
        onConfirm={() => void handleDraftOverwriteConfirm()}
        onCancel={() => setDraftConfirmOpen(false)}
      />

      <PasteTranslationModal
        open={pasteTranslationOpen()}
        episodeId={props.episodeId}
        episodeName={props.episodeName}
        folder={folder()}
        onClose={() => setPasteTranslationOpen(false)}
      />

      <PasteStylesModal
        open={pasteStylesOpen()}
        episodeId={props.episodeId}
        episodeName={props.episodeName}
        folder={folder()}
        onClose={() => setPasteStylesOpen(false)}
      />
    </div>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default TranslatePanel
