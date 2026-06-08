import { pickMkvFiles } from '@api/dialog'
import type { EpisodeRecord, ProjectJson } from '@api/projects'
import Button from '@design-system/Button'
import ProgressBar from '@design-system/ProgressBar'
import StatusBadge from '@design-system/StatusBadge'
import {
  artifactStateFor,
  cancelExtractSubtitle,
  clearJobState,
  jobStateFor,
  rememberDontAskOverwrite,
  shouldConfirmOverwrite,
  startExtractSubtitle,
  type EpisodeJobState
} from '@stores/jobs'
import { addEpisodes } from '@stores/projects'
import ExtractConfirmModal from '@views/project/ExtractConfirmModal'
import ExtractErrorModal from '@views/project/ExtractErrorModal'
import TrackPickerModal from '@views/track-picker/TrackPickerModal'
import { FilePlus2, Loader2, Plus, RotateCw, Scissors } from 'lucide-solid'
import { createSignal, For, Show, type Component } from 'solid-js'

interface ProjectViewProps {
  project: ProjectJson
  folder: string
}

/**
 * Main view when a project is open.
 *
 * Slice 0004 rendered the project header + an empty-state placeholder.
 * Slice 0005 wired drag-drop, the multi-file picker, and the
 * `EPISODES · N` list with "Trống" badges.
 * Slice 0006 added the per-Episode track-picker affordance plus the
 * language tag on rows with a selection.
 * Slice 0007 wires the extract pipeline: per-row "Trích xuất sub"
 * button → background mkvextract job → live progress bar → disk state
 * derivation → overwrite confirm + failure modals.
 *
 * The drag-drop overlay itself is hosted by `AppShell` so it covers the
 * whole window (Sidebar + StatusBar included), per the AC.
 */
const ProjectView: Component<ProjectViewProps> = props => {
  const [picking, setPicking] = createSignal(false)
  const [pickerEpisode, setPickerEpisode] = createSignal<EpisodeRecord | null>(null)
  /** Drives ExtractConfirmModal — non-null when an overwrite confirm is pending. */
  const [overwriteEpisode, setOverwriteEpisode] = createSignal<EpisodeRecord | null>(null)
  /** Drives ExtractErrorModal — non-null when the user clicked the "Lỗi extract" badge. */
  const [errorEpisode, setErrorEpisode] = createSignal<EpisodeRecord | null>(null)

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

  /**
   * EpisodeRow's extract-click entry point. Surfaces the overwrite-
   * confirm modal when `<basename>.eng.ass` already exists on disk
   * and the user hasn't toggled "Không hỏi lại" this session;
   * otherwise enqueues directly.
   */
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

  /**
   * Close the error modal. We also clear the failed `EpisodeJobState`
   * so the red "Lỗi extract" badge collapses back to the disk-only
   * appearance — the user has acknowledged the failure and the row
   * should reflect that (the underlying artefact is still missing, so
   * the badge will fall back to "Trống" via the artefact cache).
   */
  const handleErrorDismiss = (): void => {
    const episode = errorEpisode()
    if (episode) {
      clearJobState(episode.id)
    }
    setErrorEpisode(null)
  }

  return (
    <section
      class="flex h-full w-full flex-col overflow-auto px-12 py-10"
      aria-label="Project đang mở"
    >
      <header class="flex flex-col gap-2 border-b-2 border-border pb-6">
        <h1 class="text-5xl font-semibold tracking-tight text-text">
          {props.project.name}
        </h1>
        <p class="font-mono text-xs break-all text-text-muted">{props.folder}</p>
      </header>

      <div class="mt-8 flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <h2 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            EPISODES · {props.project.episodes.length}
          </h2>
          <Button
            variant="secondary"
            onClick={() => void handlePickFiles()}
            disabled={picking()}
            aria-label="Thêm Episode bằng cách chọn file MKV"
          >
            <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>Thêm Episode…</span>
          </Button>
        </div>

        <Show when={props.project.episodes.length > 0} fallback={<EpisodeListEmpty />}>
          <ul class="flex flex-col border-2 border-border" aria-label="Danh sách Episode">
            <For each={props.project.episodes}>
              {(episode, index) => (
                <EpisodeRow
                  episode={episode}
                  isLast={index() === props.project.episodes.length - 1}
                  onPickTrack={() => setPickerEpisode(episode)}
                  onExtract={() => handleExtractRequest(episode)}
                  onCancelExtract={() => void cancelExtractSubtitle(episode.id)}
                  onShowError={() => setErrorEpisode(episode)}
                />
              )}
            </For>
          </ul>
        </Show>
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

      <ExtractErrorModal
        open={errorEpisode() !== null}
        onClose={handleErrorDismiss}
        episodeName={errorEpisode()?.folder_name ?? ''}
        stderr={errorEpisode() ? jobStateFor(errorEpisode()!.id).stderr : ''}
        errorMessage={errorEpisode() ? jobStateFor(errorEpisode()!.id).error : null}
        exitCode={errorEpisode() ? jobStateFor(errorEpisode()!.id).exitCode : null}
      />
    </section>
  )
}

interface EpisodeRowProps {
  episode: EpisodeRecord
  isLast: boolean
  onPickTrack: () => void
  onExtract: () => void
  onCancelExtract: () => void
  onShowError: () => void
}

/**
 * One row in the Episode list.
 *
 * Layout: folder name (truncated, full path on title hover) + source
 * MKV path in mono on the left; on the right a stack of the selected
 * language tag (slice 0006), the derived state badge or progress bar
 * (slice 0007), the primary action button (Trích xuất sub / Hủy /
 * Thử lại / Chọn track), and the "Đổi track" link when a track is
 * already picked.
 *
 * Reads the live extract-job phase and the disk-artefact cache
 * directly from `@stores/jobs` so the row re-renders on each
 * `job-progress` event without prop-drilling the snapshot.
 */
const EpisodeRow: Component<EpisodeRowProps> = props => {
  const hasSelection = (): boolean => props.episode.selected_subtitle_track_id !== null
  const languageTag = (): string =>
    (props.episode.selected_subtitle_language ?? 'und').toUpperCase()

  const job = (): EpisodeJobState => jobStateFor(props.episode.id)
  const hasExtractedSub = (): boolean =>
    artifactStateFor(props.episode.id)?.hasExtractedSub ?? false

  const isQueued = (): boolean => job().phase === 'queued'
  const isRunning = (): boolean => job().phase === 'running'
  const isFailed = (): boolean => job().phase === 'failed'
  const isInFlight = (): boolean => isQueued() || isRunning()

  return (
    <li
      class={[
        'flex items-center justify-between gap-6 px-5 py-4',
        props.isLast ? '' : 'border-b-2 border-border'
      ].join(' ')}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span
          class="truncate text-base font-medium text-text"
          title={props.episode.source_mkv_path}
        >
          {props.episode.folder_name}
        </span>
        <span
          class="truncate font-mono text-xs text-text-muted"
          title={props.episode.source_mkv_path}
        >
          {props.episode.source_mkv_path}
        </span>
      </div>
      <div class="flex flex-none items-center gap-3">
        <Show when={hasSelection()}>
          <StatusBadge tone="neutral">{languageTag()}</StatusBadge>
        </Show>

        <StateSlot
          isQueued={isQueued()}
          isRunning={isRunning()}
          isFailed={isFailed()}
          hasExtractedSub={hasExtractedSub()}
          ratio={job().ratio}
          hint={job().hint}
          onShowError={props.onShowError}
        />

        <ActionButton
          hasSelection={hasSelection()}
          isInFlight={isInFlight()}
          isFailed={isFailed()}
          onPickTrack={props.onPickTrack}
          onExtract={props.onExtract}
          onCancelExtract={props.onCancelExtract}
        />

        <Show when={hasSelection() && !isInFlight()}>
          <button
            type="button"
            onClick={() => props.onPickTrack()}
            class="text-sm font-medium text-accent underline-offset-4 transition-colors hover:text-text hover:underline"
            aria-label="Đổi subtitle track cho Episode này"
          >
            Đổi track
          </button>
        </Show>
      </div>
    </li>
  )
}

interface StateSlotProps {
  isQueued: boolean
  isRunning: boolean
  isFailed: boolean
  hasExtractedSub: boolean
  ratio: number
  hint: string
  onShowError: () => void
}

/**
 * The middle slot in the right cluster — renders one of:
 *  - Progress bar + hint (running)
 *  - Accent "Đang chờ" badge (queued, pre-`job-started`)
 *  - Danger "Lỗi extract" clickable badge (failed)
 *  - Accent "Đã extract" badge (disk has `<basename>.eng.ass`)
 *  - Accent "Trống" badge (default empty state)
 *
 * Kept as a sibling component so the precedence order is explicit and
 * the `<Switch>` doesn't crowd the row template.
 */
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
                fallback={<StatusBadge tone="accent">Trống</StatusBadge>}
              >
                <StatusBadge tone="accent">Đã extract</StatusBadge>
              </Show>
            }
          >
            <button
              type="button"
              onClick={() => props.onShowError()}
              class="inline-flex items-center gap-1.5 border-2 border-danger bg-bg px-2.5 py-1 font-mono text-xs font-medium tracking-wide text-danger uppercase transition-colors hover:bg-danger hover:text-accent-on-accent"
              aria-label="Xem chi tiết lỗi extract"
            >
              Lỗi extract
            </button>
          </Show>
        }
      >
        <StatusBadge tone="accent">Đang chờ</StatusBadge>
      </Show>
    }
  >
    <div class="flex w-40 items-center gap-2">
      <ProgressBar
        ratio={props.ratio}
        ariaLabel="Đang trích xuất phụ đề"
        ariaValueText={props.hint || `${Math.round(props.ratio * 100)}%`}
      />
      <span class="w-10 text-right font-mono text-xs text-text-muted">
        {props.hint || `${Math.round(props.ratio * 100)}%`}
      </span>
    </div>
  </Show>
)

interface ActionButtonProps {
  hasSelection: boolean
  isInFlight: boolean
  isFailed: boolean
  onPickTrack: () => void
  onExtract: () => void
  onCancelExtract: () => void
}

/**
 * Primary action button on the right of each row. State transitions:
 *  - No track:               "Chọn track" (secondary, opens picker)
 *  - Track + idle:           "Trích xuất sub" (primary, kicks the job)
 *  - In-flight (q'd/running): "Hủy" (secondary, cancels)
 *  - Failed:                 "Thử lại" (primary, re-extracts — overwrite
 *                            confirm flow same as the idle path)
 *
 * The "Trích xuất sub" button is the slice 0007 AC's gated affordance:
 * it stays mounted even when no track is selected so the disabled
 * tooltip ("Chọn subtitle track trước Episode này") explains the
 * gating — the second `Chọn track` button is the way out.
 */
const ActionButton: Component<ActionButtonProps> = props => (
  <Show
    when={props.hasSelection}
    fallback={
      <>
        <Button
          variant="primary"
          onClick={() => props.onExtract()}
          disabled
          title="Chọn subtitle track trước"
          aria-label="Trích xuất subtitle (yêu cầu chọn track trước)"
        >
          <Scissors size={18} strokeWidth={1.5} aria-hidden="true" />
          <span>Trích xuất sub</span>
        </Button>
        <Button
          variant="secondary"
          onClick={() => props.onPickTrack()}
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
              onClick={() => props.onExtract()}
              aria-label="Trích xuất phụ đề cho Episode này"
            >
              <Scissors size={18} strokeWidth={1.5} aria-hidden="true" />
              <span>Trích xuất sub</span>
            </Button>
          }
        >
          <Button
            variant="primary"
            onClick={() => props.onExtract()}
            aria-label="Thử trích xuất lại"
          >
            <RotateCw size={18} strokeWidth={1.5} aria-hidden="true" />
            <span>Thử lại</span>
          </Button>
        </Show>
      }
    >
      <Button
        variant="secondary"
        onClick={() => props.onCancelExtract()}
        aria-label="Hủy job extract đang chạy"
      >
        <Loader2 size={18} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
        <span>Hủy</span>
      </Button>
    </Show>
  </Show>
)

/**
 * Empty-state for the Episode list — the AC strings exactly. Slice 0005
 * keeps this prompt around even though the drag overlay is wired,
 * because users land on the empty Project view before initiating their
 * first drag.
 */
const EpisodeListEmpty: Component = () => (
  <div
    class="flex min-h-[260px] flex-col items-center justify-center gap-3 border-2 border-dashed border-border bg-bg px-6 py-12 text-center"
    aria-label="Chưa có episode nào"
  >
    <FilePlus2 size={32} strokeWidth={1.5} class="text-text-muted" aria-hidden="true" />
    <p class="text-base text-text">Thả file MKV vào đây để thêm Episode</p>
    <p class="font-mono text-xs text-text-muted">
      Hoặc dùng nút "Thêm Episode…" để chọn file qua hộp thoại.
    </p>
  </div>
)

export default ProjectView
