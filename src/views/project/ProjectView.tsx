import { pickMkvFiles, pickSingleMkv } from '@api/dialog'
import type { EpisodeRecord, ProjectJson } from '@api/projects'
import Button from '@design-system/Button'
import ProgressBar from '@design-system/ProgressBar'
import StatusBadge from '@design-system/StatusBadge'
import Stepper, { type Step, type StepStatus } from '@design-system/Stepper'
import {
  artifactStateFor,
  cancelExtractAudio,
  cancelExtractSubtitle,
  clearJobState,
  jobStateFor,
  refreshArtifactsForEpisode,
  rememberDontAskAudioOverwrite,
  rememberDontAskOverwrite,
  shouldConfirmAudioOverwrite,
  shouldConfirmOverwrite,
  startExtractAudio,
  startExtractSubtitle,
  type EpisodeJobState
} from '@stores/jobs'
import { addEpisodes, relocateEpisode } from '@stores/projects'
import AudioOverwriteConfirmModal from '@views/project/AudioOverwriteConfirmModal'
import DeleteProjectModal from '@views/project/DeleteProjectModal'
import ExtractConfirmModal from '@views/project/ExtractConfirmModal'
import ExtractErrorModal from '@views/project/ExtractErrorModal'
import ProjectSettingsModal from '@views/project/ProjectSettingsModal'
import RemoveEpisodeModal from '@views/project/RemoveEpisodeModal'
import RenameProjectModal from '@views/project/RenameProjectModal'
import RenderPanel from '@views/project/render/RenderPanel'
import TranslatePanel from '@views/project/translate/TranslatePanel'
import TrackPickerModal from '@views/track-picker/TrackPickerModal'
import {
  AudioLines,
  FilePlus2,
  FolderInput,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RotateCw,
  Scissors,
  Settings,
  Trash2
} from 'lucide-solid'
import { createSignal, For, Show, type Component } from 'solid-js'

interface ProjectViewProps {
  project: ProjectJson
  folder: string
}

/**
 * Project view — Rounded Flat refresh.
 *
 * The view is reorganised as a wizard around the canonical pipeline:
 *
 *   ① Source MKV → ② Extract → ③ Translate → ④ Render
 *
 * The header carries the project name + actions and a four-step
 * Stepper that summarises the aggregate state across all Episodes.
 * Each Episode is then its own rounded card with a `compact` Stepper
 * at the top so the same wizard vocabulary applies row-by-row.
 *
 * No edge-to-edge dividers — every section is a rounded surface card
 * separated by spacing only.
 */
const ProjectView: Component<ProjectViewProps> = props => {
  const [picking, setPicking] = createSignal(false)
  const [pickerEpisode, setPickerEpisode] = createSignal<EpisodeRecord | null>(null)
  const [overwriteEpisode, setOverwriteEpisode] = createSignal<EpisodeRecord | null>(null)
  const [audioOverwriteEpisode, setAudioOverwriteEpisode] =
    createSignal<EpisodeRecord | null>(null)
  const [errorEpisode, setErrorEpisode] = createSignal<EpisodeRecord | null>(null)
  const [projectSettingsOpen, setProjectSettingsOpen] = createSignal(false)
  const [renameOpen, setRenameOpen] = createSignal(false)
  const [deleteOpen, setDeleteOpen] = createSignal(false)
  const [removeEpisode, setRemoveEpisode] = createSignal<EpisodeRecord | null>(null)

  const handlePickFiles = async (): Promise<void> => {
    if (picking()) return
    setPicking(true)
    try {
      const paths = await pickMkvFiles('Chọn file MKV để thêm Episode')
      if (paths.length === 0) return
      await addEpisodes(paths)
    } finally {
      setPicking(false)
    }
  }

  const handleExtractRequest = (episode: EpisodeRecord): void => {
    if (shouldConfirmOverwrite(episode.id)) {
      setOverwriteEpisode(episode)
    } else {
      void startExtractSubtitle(episode.id)
    }
  }

  const handleOverwriteConfirm = (rememberDontAsk: boolean): void => {
    const episode = overwriteEpisode()
    if (!episode) return
    if (rememberDontAsk) {
      rememberDontAskOverwrite(episode.id)
    }
    setOverwriteEpisode(null)
    void startExtractSubtitle(episode.id)
  }

  const handleAudioExtractRequest = (episode: EpisodeRecord): void => {
    if (shouldConfirmAudioOverwrite(episode.id)) {
      setAudioOverwriteEpisode(episode)
    } else {
      void startExtractAudio(episode.id)
    }
  }

  const handleAudioOverwriteConfirm = (rememberDontAsk: boolean): void => {
    const episode = audioOverwriteEpisode()
    if (!episode) return
    if (rememberDontAsk) {
      rememberDontAskAudioOverwrite(episode.id)
    }
    setAudioOverwriteEpisode(null)
    void startExtractAudio(episode.id)
  }

  const handleErrorDismiss = (): void => {
    const episode = errorEpisode()
    if (episode) {
      clearJobState(episode.id)
    }
    setErrorEpisode(null)
  }

  const handleRelocate = async (episode: EpisodeRecord): Promise<void> => {
    const newPath = await pickSingleMkv(`Chọn file MKV mới cho "${episode.folder_name}"`)
    if (!newPath) return
    try {
      await relocateEpisode(episode.id, newPath)
      await refreshArtifactsForEpisode(episode.id)
    } catch {
      /* toast already surfaced */
    }
  }

  const projectStepperSteps = (): Step[] => {
    const total = props.project.episodes.length
    const withSelection = props.project.episodes.filter(
      e => e.selected_subtitle_track_id !== null
    ).length
    let extracted = 0
    let translated = 0
    let rendered = 0
    for (const ep of props.project.episodes) {
      const art = artifactStateFor(ep.id)
      if (art?.hasExtractedSub) extracted += 1
      if (art?.hasTranslatedSub) translated += 1
      if (art?.hasRender) rendered += 1
    }
    const stage = (
      complete: number,
      previousStageComplete: number
    ): StepStatus => {
      if (total === 0) return 'upcoming'
      if (complete >= total) return 'done'
      if (previousStageComplete > complete) return 'current'
      return 'upcoming'
    }
    return [
      {
        id: 'source',
        label: 'Nguồn',
        sublabel: total === 0 ? 'Chưa có Episode' : `${total} Episode`,
        status: total === 0 ? 'current' : 'done'
      },
      {
        id: 'extract',
        label: 'Trích xuất',
        sublabel: total === 0 ? '—' : `${extracted}/${total} sub`,
        status: stage(extracted, withSelection)
      },
      {
        id: 'translate',
        label: 'Dịch',
        sublabel: total === 0 ? '—' : `${translated}/${total} vietsub`,
        status: stage(translated, extracted)
      },
      {
        id: 'render',
        label: 'Render',
        sublabel: total === 0 ? '—' : `${rendered}/${total} mp4`,
        status: stage(rendered, translated)
      }
    ]
  }

  return (
    <section
      class="flex h-full w-full flex-col overflow-auto px-8 py-8"
      aria-label="Project đang mở"
    >
      <div class="flex w-full max-w-6xl flex-col gap-6 self-center">
        <header class="flex flex-col gap-6 rounded-[28px] border border-border bg-elevated px-7 py-7">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex min-w-0 flex-col gap-2">
              <span class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
                Project hiện hành
              </span>
              <h1 class="text-4xl font-semibold tracking-tight text-text">
                {props.project.name}
              </h1>
              <p class="font-mono text-[11px] break-all text-text-faint">{props.folder}</p>
            </div>
            <div class="flex flex-none items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => setRenameOpen(true)}
                aria-label="Đổi tên project"
              >
                <Pencil size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>Đổi tên</span>
              </Button>
              <Button
                variant="secondary"
                onClick={() => setProjectSettingsOpen(true)}
                aria-label="Mở cấu hình project"
              >
                <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>Cấu hình</span>
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
                aria-label="Xoá project"
                class="text-danger hover:bg-danger-soft hover:text-danger"
              >
                <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>Xoá</span>
              </Button>
            </div>
          </div>
          <Stepper steps={projectStepperSteps()} size="comfortable" />
        </header>

        <section class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center justify-between gap-4 px-2">
            <div class="flex items-center gap-3">
              <h2 class="font-mono text-[11px] font-semibold tracking-[0.22em] text-text-muted uppercase">
                Episodes
              </h2>
              <span class="rounded-full bg-elevated px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-text-muted">
                {props.project.episodes.length} TỔNG
              </span>
            </div>
            <Button
              variant="primary"
              onClick={() => void handlePickFiles()}
              disabled={picking()}
              aria-label="Thêm Episode bằng cách chọn file MKV"
            >
              <Plus size={18} strokeWidth={2} aria-hidden="true" />
              <span>Thêm Episode</span>
            </Button>
          </div>

          <Show when={props.project.episodes.length > 0} fallback={<EpisodeListEmpty />}>
            <ul class="flex flex-col gap-3" aria-label="Danh sách Episode">
              <For each={props.project.episodes}>
                {(episode, index) => (
                  <EpisodeCard
                    episode={episode}
                    indexLabel={String(index() + 1).padStart(2, '0')}
                    onPickTrack={() => setPickerEpisode(episode)}
                    onExtract={() => handleExtractRequest(episode)}
                    onCancelExtract={() => void cancelExtractSubtitle(episode.id)}
                    onShowError={() => setErrorEpisode(episode)}
                    onExtractAudio={() => handleAudioExtractRequest(episode)}
                    onCancelAudio={() => void cancelExtractAudio(episode.id)}
                    onRelocate={() => void handleRelocate(episode)}
                    onRemove={() => setRemoveEpisode(episode)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>

      <TrackPickerModal
        open={pickerEpisode() !== null}
        onClose={() => setPickerEpisode(null)}
        folder={props.folder}
        episodeId={pickerEpisode()?.id ?? ''}
        episodeName={pickerEpisode()?.folder_name ?? ''}
        initialTrackId={pickerEpisode()?.selected_subtitle_track_id ?? null}
      />

      <ExtractConfirmModal
        open={overwriteEpisode() !== null}
        episodeName={overwriteEpisode()?.folder_name ?? ''}
        onConfirm={handleOverwriteConfirm}
        onCancel={() => setOverwriteEpisode(null)}
      />

      <AudioOverwriteConfirmModal
        open={audioOverwriteEpisode() !== null}
        episodeName={audioOverwriteEpisode()?.folder_name ?? ''}
        audioExtension={
          audioOverwriteEpisode()
            ? (artifactStateFor(audioOverwriteEpisode()!.id)?.audioExtension ?? 'mp3')
            : 'mp3'
        }
        onConfirm={handleAudioOverwriteConfirm}
        onCancel={() => setAudioOverwriteEpisode(null)}
      />

      <ExtractErrorModal
        open={errorEpisode() !== null}
        onClose={handleErrorDismiss}
        episodeName={errorEpisode()?.folder_name ?? ''}
        stderr={errorEpisode() ? jobStateFor(errorEpisode()!.id).stderr : ''}
        errorMessage={errorEpisode() ? jobStateFor(errorEpisode()!.id).error : null}
        exitCode={errorEpisode() ? jobStateFor(errorEpisode()!.id).exitCode : null}
      />

      <ProjectSettingsModal
        open={projectSettingsOpen()}
        onClose={() => setProjectSettingsOpen(false)}
      />

      <RenameProjectModal
        open={renameOpen()}
        currentName={props.project.name}
        onClose={() => setRenameOpen(false)}
      />

      <DeleteProjectModal
        open={deleteOpen()}
        projectName={props.project.name}
        folder={props.folder}
        onClose={() => setDeleteOpen(false)}
      />

      <RemoveEpisodeModal
        open={removeEpisode() !== null}
        episodeName={removeEpisode()?.folder_name ?? ''}
        episodeId={removeEpisode()?.id ?? ''}
        onClose={() => setRemoveEpisode(null)}
      />
    </section>
  )
}

interface EpisodeCardProps {
  episode: EpisodeRecord
  indexLabel: string
  onPickTrack: () => void
  onExtract: () => void
  onCancelExtract: () => void
  onShowError: () => void
  onExtractAudio: () => void
  onCancelAudio: () => void
  onRelocate: () => void
  onRemove: () => void
}

const EpisodeCard: Component<EpisodeCardProps> = props => {
  const hasSelection = (): boolean => props.episode.selected_subtitle_track_id !== null
  const languageTag = (): string =>
    (props.episode.selected_subtitle_language ?? 'und').toUpperCase()

  const subJob = (): EpisodeJobState => jobStateFor(props.episode.id, 'extract_subtitle')
  const audioJob = (): EpisodeJobState => jobStateFor(props.episode.id, 'extract_audio')
  const hasExtractedSub = (): boolean =>
    artifactStateFor(props.episode.id)?.hasExtractedSub ?? false
  const hasExtractedAudio = (): boolean =>
    artifactStateFor(props.episode.id)?.hasExtractedAudio ?? false
  const hasTranslatedSub = (): boolean =>
    artifactStateFor(props.episode.id)?.hasTranslatedSub ?? false
  const isSourceMissing = (): boolean =>
    artifactStateFor(props.episode.id)?.isSourceMissing ?? false

  const isSubQueued = (): boolean => subJob().phase === 'queued'
  const isSubRunning = (): boolean => subJob().phase === 'running'
  const isSubFailed = (): boolean => subJob().phase === 'failed'
  const isSubInFlight = (): boolean => isSubQueued() || isSubRunning()

  const isAudioQueued = (): boolean => audioJob().phase === 'queued'
  const isAudioRunning = (): boolean => audioJob().phase === 'running'
  const isAudioFailed = (): boolean => audioJob().phase === 'failed'
  const isAudioInFlight = (): boolean => isAudioQueued() || isAudioRunning()

  const [menuOpen, setMenuOpen] = createSignal(false)

  const episodeStepperSteps = (): Step[] => {
    const sourceStatus: StepStatus = isSourceMissing() ? 'error' : 'done'
    const extractStatus: StepStatus = isSubFailed()
      ? 'error'
      : hasExtractedSub()
        ? 'done'
        : isSubInFlight()
          ? 'current'
          : hasSelection()
            ? 'current'
            : 'upcoming'
    const translateStatus: StepStatus = hasTranslatedSub()
      ? 'done'
      : hasExtractedSub()
        ? 'current'
        : 'upcoming'
    const renderStatus: StepStatus = (artifactStateFor(props.episode.id)?.hasRender ?? false)
      ? artifactStateFor(props.episode.id)?.isRenderStale
        ? 'error'
        : 'done'
      : hasTranslatedSub()
        ? 'current'
        : 'upcoming'
    return [
      { id: 'src', label: 'Nguồn', status: sourceStatus },
      { id: 'ext', label: 'Sub', status: extractStatus },
      { id: 'tr', label: 'Dịch', status: translateStatus },
      { id: 'rd', label: 'Render', status: renderStatus }
    ]
  }

  return (
    <li class="overflow-hidden rounded-[24px] border border-border bg-elevated">
      <div class="flex flex-col gap-5 p-6">
        <div class="flex items-start justify-between gap-4">
          <div class="flex min-w-0 flex-1 items-start gap-4">
            <span
              class="flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-surface font-mono text-sm font-semibold text-text-muted"
              aria-hidden="true"
            >
              {props.indexLabel}
            </span>
            <div class="flex min-w-0 flex-col gap-1.5">
              <span
                class="truncate text-base font-semibold text-text"
                title={props.episode.source_mkv_path}
              >
                {props.episode.folder_name}
              </span>
              <span
                class="truncate font-mono text-[11px] text-text-faint"
                title={props.episode.source_mkv_path}
              >
                {props.episode.source_mkv_path}
              </span>
              <Show when={isSourceMissing()}>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <StatusBadge tone="danger">MKV gốc không tìm thấy</StatusBadge>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => props.onRelocate()}
                    aria-label="Chọn lại file MKV gốc"
                  >
                    <FolderInput size={14} strokeWidth={1.5} aria-hidden="true" />
                    <span>Relocate</span>
                  </Button>
                </div>
              </Show>
            </div>
          </div>
          <div class="relative flex flex-none items-center gap-2">
            <Show when={hasSelection()}>
              <StatusBadge tone="neutral" variant="outline">
                {languageTag()}
              </StatusBadge>
            </Show>
            <button
              type="button"
              onClick={() => setMenuOpen(v => !v)}
              onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
              class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-text-muted transition-colors hover:border-accent hover:text-accent"
              aria-label="Mở menu Episode"
              aria-expanded={menuOpen()}
            >
              <MoreVertical size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <Show when={menuOpen()}>
              <div
                class="absolute top-full right-0 z-10 mt-2 flex w-56 flex-col overflow-hidden rounded-2xl border border-border bg-surface p-1"
                role="menu"
              >
                <button
                  type="button"
                  onMouseDown={() => {
                    setMenuOpen(false)
                    props.onRelocate()
                  }}
                  class="flex items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm text-text transition-colors hover:bg-elevated hover:text-accent"
                  role="menuitem"
                >
                  <FolderInput size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span>Đổi đường dẫn MKV…</span>
                </button>
                <button
                  type="button"
                  onMouseDown={() => {
                    setMenuOpen(false)
                    props.onRemove()
                  }}
                  class="flex items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm text-danger transition-colors hover:bg-danger-soft"
                  role="menuitem"
                >
                  <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span>Xoá Episode…</span>
                </button>
              </div>
            </Show>
          </div>
        </div>

        <div class="rounded-2xl border border-border bg-surface px-5 py-4">
          <Stepper steps={episodeStepperSteps()} size="compact" />
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <PipelineRow
            label="Phụ đề"
            slot={
              <StateSlot
                isQueued={isSubQueued()}
                isRunning={isSubRunning()}
                isFailed={isSubFailed()}
                hasExtractedSub={hasExtractedSub()}
                ratio={subJob().ratio}
                hint={subJob().hint}
                onShowError={props.onShowError}
              />
            }
            action={
              <ActionButton
                hasSelection={hasSelection()}
                isInFlight={isSubInFlight()}
                isFailed={isSubFailed()}
                isSourceMissing={isSourceMissing()}
                onPickTrack={props.onPickTrack}
                onExtract={props.onExtract}
                onCancelExtract={props.onCancelExtract}
              />
            }
            secondary={
              <Show when={hasSelection() && !isSubInFlight()}>
                <button
                  type="button"
                  onClick={() => props.onPickTrack()}
                  class="text-xs font-medium text-accent underline-offset-4 transition-colors hover:text-text hover:underline"
                  aria-label="Đổi subtitle track cho Episode này"
                >
                  Đổi track
                </button>
              </Show>
            }
          />
          <PipelineRow
            label="Audio"
            slot={
              <AudioStateSlot
                isQueued={isAudioQueued()}
                isRunning={isAudioRunning()}
                isFailed={isAudioFailed()}
                hasExtractedAudio={hasExtractedAudio()}
                ratio={audioJob().ratio}
                hint={audioJob().hint}
              />
            }
            action={
              <AudioActionButton
                isInFlight={isAudioInFlight()}
                isFailed={isAudioFailed()}
                isSourceMissing={isSourceMissing()}
                onExtractAudio={props.onExtractAudio}
                onCancelAudio={props.onCancelAudio}
              />
            }
          />
        </div>

        <Show when={hasExtractedSub()}>
          <TranslatePanel
            episodeId={props.episode.id}
            episodeName={props.episode.folder_name}
          />
        </Show>

        <Show when={hasTranslatedSub()}>
          <RenderPanel
            episodeId={props.episode.id}
            episodeName={props.episode.folder_name}
          />
        </Show>
      </div>
    </li>
  )
}

interface PipelineRowProps {
  label: string
  slot: import('solid-js').JSX.Element
  action: import('solid-js').JSX.Element
  secondary?: import('solid-js').JSX.Element
}

const PipelineRow: Component<PipelineRowProps> = props => (
  <div class="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
    <div class="flex items-center justify-between gap-3">
      <span class="font-mono text-[10px] font-semibold tracking-[0.22em] text-text-muted uppercase">
        {props.label}
      </span>
      {props.secondary}
    </div>
    <div class="min-h-[28px]">{props.slot}</div>
    <div class="flex flex-wrap items-center gap-2">{props.action}</div>
  </div>
)

interface StateSlotProps {
  isQueued: boolean
  isRunning: boolean
  isFailed: boolean
  hasExtractedSub: boolean
  ratio: number
  hint: string
  onShowError: () => void
}

const StateSlot: Component<StateSlotProps> = props => (
  <Show
    when={props.isRunning}
    fallback={
      <Show
        when={props.isQueued}
        fallback={
          <Show
            when={props.isFailed}
            fallback={
              <Show
                when={props.hasExtractedSub}
                fallback={<StatusBadge tone="neutral">Trống</StatusBadge>}
              >
                <StatusBadge tone="accent">Đã extract</StatusBadge>
              </Show>
            }
          >
            <button
              type="button"
              onClick={() => props.onShowError()}
              class="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-3 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] text-danger uppercase transition-colors hover:bg-danger hover:text-accent-on-accent"
              aria-label="Xem chi tiết lỗi extract"
            >
              Lỗi extract
            </button>
          </Show>
        }
      >
        <StatusBadge tone="warn">Đang chờ</StatusBadge>
      </Show>
    }
  >
    <div class="flex items-center gap-3">
      <ProgressBar
        ratio={props.ratio}
        ariaLabel="Đang trích xuất phụ đề"
        ariaValueText={props.hint || `${Math.round(props.ratio * 100)}%`}
      />
      <span class="w-12 flex-none text-right font-mono text-[11px] text-text-muted">
        {props.hint || `${Math.round(props.ratio * 100)}%`}
      </span>
    </div>
  </Show>
)

interface ActionButtonProps {
  hasSelection: boolean
  isInFlight: boolean
  isFailed: boolean
  isSourceMissing: boolean
  onPickTrack: () => void
  onExtract: () => void
  onCancelExtract: () => void
}

const ActionButton: Component<ActionButtonProps> = props => (
  <Show
    when={props.hasSelection}
    fallback={
      <>
        <Button
          variant="primary"
          size="sm"
          onClick={() => props.onExtract()}
          disabled
          title={
            props.isSourceMissing ? 'MKV gốc không tìm thấy' : 'Chọn subtitle track trước'
          }
          aria-label="Trích xuất subtitle (yêu cầu chọn track trước)"
        >
          <Scissors size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Trích xuất sub</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => props.onPickTrack()}
          disabled={props.isSourceMissing}
          title={props.isSourceMissing ? 'MKV gốc không tìm thấy' : undefined}
          aria-label="Chọn subtitle track cho Episode này"
        >
          <span>Chọn track</span>
        </Button>
      </>
    }
  >
    <Show
      when={props.isInFlight}
      fallback={
        <Show
          when={props.isFailed}
          fallback={
            <Button
              variant="primary"
              size="sm"
              onClick={() => props.onExtract()}
              disabled={props.isSourceMissing}
              title={props.isSourceMissing ? 'MKV gốc không tìm thấy' : undefined}
              aria-label="Trích xuất phụ đề cho Episode này"
            >
              <Scissors size={14} strokeWidth={1.5} aria-hidden="true" />
              <span>Trích xuất sub</span>
            </Button>
          }
        >
          <Button
            variant="primary"
            size="sm"
            onClick={() => props.onExtract()}
            disabled={props.isSourceMissing}
            title={props.isSourceMissing ? 'MKV gốc không tìm thấy' : undefined}
            aria-label="Thử trích xuất lại"
          >
            <RotateCw size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>Thử lại</span>
          </Button>
        </Show>
      }
    >
      <Button
        variant="secondary"
        size="sm"
        onClick={() => props.onCancelExtract()}
        aria-label="Hủy job extract đang chạy"
      >
        <Loader2 size={14} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
        <span>Hủy</span>
      </Button>
    </Show>
  </Show>
)

interface AudioStateSlotProps {
  isQueued: boolean
  isRunning: boolean
  isFailed: boolean
  hasExtractedAudio: boolean
  ratio: number
  hint: string
}

const AudioStateSlot: Component<AudioStateSlotProps> = props => (
  <Show
    when={props.isRunning}
    fallback={
      <Show
        when={props.isQueued}
        fallback={
          <Show
            when={props.isFailed}
            fallback={
              <Show
                when={props.hasExtractedAudio}
                fallback={<StatusBadge tone="neutral">Trống</StatusBadge>}
              >
                <StatusBadge tone="accent">Đã có audio</StatusBadge>
              </Show>
            }
          >
            <StatusBadge tone="danger">Lỗi audio</StatusBadge>
          </Show>
        }
      >
        <StatusBadge tone="warn">Đang chờ</StatusBadge>
      </Show>
    }
  >
    <div class="flex items-center gap-3">
      <ProgressBar
        ratio={props.ratio}
        ariaLabel="Đang trích xuất audio"
        ariaValueText={props.hint || `${Math.round(props.ratio * 100)}%`}
      />
      <span class="w-12 flex-none text-right font-mono text-[11px] text-text-muted">
        {props.hint || `${Math.round(props.ratio * 100)}%`}
      </span>
    </div>
  </Show>
)

interface AudioActionButtonProps {
  isInFlight: boolean
  isFailed: boolean
  isSourceMissing: boolean
  onExtractAudio: () => void
  onCancelAudio: () => void
}

const AudioActionButton: Component<AudioActionButtonProps> = props => (
  <Show
    when={props.isInFlight}
    fallback={
      <Show
        when={props.isFailed}
        fallback={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => props.onExtractAudio()}
            disabled={props.isSourceMissing}
            title={props.isSourceMissing ? 'MKV gốc không tìm thấy' : undefined}
            aria-label="Trích xuất audio cho Episode này"
          >
            <AudioLines size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>Trích xuất audio</span>
          </Button>
        }
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => props.onExtractAudio()}
          disabled={props.isSourceMissing}
          title={props.isSourceMissing ? 'MKV gốc không tìm thấy' : undefined}
          aria-label="Thử trích xuất audio lại"
        >
          <RotateCw size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>Thử lại</span>
        </Button>
      </Show>
    }
  >
    <Button
      variant="secondary"
      size="sm"
      onClick={() => props.onCancelAudio()}
      aria-label="Hủy job audio đang chạy"
    >
      <Loader2 size={14} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
      <span>Hủy</span>
    </Button>
  </Show>
)

const EpisodeListEmpty: Component = () => (
  <div
    class="flex min-h-[280px] flex-col items-center justify-center gap-4 rounded-[28px] border-2 border-dashed border-border bg-elevated px-6 py-12 text-center"
    aria-label="Chưa có episode nào"
  >
    <span
      class="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface text-text-muted"
      aria-hidden="true"
    >
      <FilePlus2 size={28} strokeWidth={1.5} />
    </span>
    <div class="flex flex-col gap-2">
      <p class="text-base font-medium text-text">Thả file MKV vào đây để thêm Episode</p>
      <p class="font-mono text-[11px] tracking-wide text-text-muted">
        Hoặc dùng nút "Thêm Episode" ở trên để chọn file qua hộp thoại.
      </p>
    </div>
  </div>
)

export default ProjectView
