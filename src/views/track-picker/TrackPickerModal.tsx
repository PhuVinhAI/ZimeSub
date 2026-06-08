import {
  listSubtitleTracks,
  type ListSubtitleTracksOutcome,
  type SubtitleTrack
} from '@api/mkv_probe'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import StatusBadge from '@design-system/StatusBadge'
import TerminalLog, { type TerminalLogLine } from '@design-system/TerminalLog'
import { setEpisodeSelectedTrack } from '@stores/projects'
import { Check, Loader2, RotateCw } from 'lucide-solid'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
  type Component
} from 'solid-js'

/**
 * Track-picker modal — slice 0006.
 *
 * Lifecycle:
 *  1. On `open` flipping `true`, runs `episode_list_subtitle_tracks`
 *     (which spawns `mkvmerge -i -F json <source_mkv_path>` in the
 *     background) and renders one of four states from the result:
 *       - Loading:    spinner + "Đang phân tích MKV..."
 *       - Error:      stderr in a `TerminalLog` + "Thử lại" button (AC).
 *       - Success:    table of tracks, pre-selected row highlighted per
 *                     backend's `preselected_index` (which already
 *                     applied the AC's three-rule heuristic), or the
 *                     user's previously-saved pick when it's still
 *                     extractable (Đổi track flow).
 *       - No-text:    red banner "Không có subtitle track text-based
 *                     trong file này" — table still shown for context
 *                     so the user sees which bitmap rows exist.
 *  2. User clicks a selectable row (codec `ass` / `srt`). Bitmap and
 *     other rows are non-interactive and styled at reduced opacity.
 *  3. User confirms → backend writes `selected_subtitle_track_id` +
 *     `selected_subtitle_language` to `zimesub.json` and returns the
 *     post-write `ProjectJson`; the store swaps `active`; the modal
 *     closes; the Episode row re-renders with the language tag.
 *
 * All UI strings Vietnamese per PRD § "UI shell & language".
 */
interface TrackPickerModalProps {
  open: boolean
  onClose: () => void
  folder: string
  episodeId: string
  episodeName: string
  /**
   * Previously-saved selection on this Episode. When non-null and the
   * track is still present + extractable on re-probe, the modal pre-
   * selects it instead of the heuristic suggestion. Drives the "Đổi
   * track" flow — the modal is fully aware of the existing pick.
   */
  initialTrackId: number | null
}

/**
 * The modal's internal phase. Discriminated by `kind` so the renderer
 * can narrow without ad-hoc null checks. `saving` keeps the previous
 * `tracks`/`selectedIdx` around so the table doesn't visually clear
 * during the brief `project_set_selected_track` round-trip.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; stderr: string; exitCode: number | null }
  | { kind: 'success'; tracks: SubtitleTrack[]; selectedIdx: number | null }
  | { kind: 'no-text'; tracks: SubtitleTrack[] }
  | { kind: 'saving'; tracks: SubtitleTrack[]; selectedIdx: number }

/**
 * View-model derivation for the table pane. `null` whenever the modal
 * is showing a non-table state (loading / error / idle); otherwise a
 * structurally-stable record the JSX reads reactively via the
 * `createMemo` accessor. Keeping this shape consistent across
 * `success` / `saving` / `no-text` is what lets the `<Show>` keyed
 * branch render the same `<TracksTable>` without remounting on
 * `selectedIdx` ticks.
 */
interface TableViewModel {
  tracks: SubtitleTrack[]
  selectedIdx: number | null
  disabled: boolean
}

const TrackPickerModal: Component<TrackPickerModalProps> = props => {
  const [phase, setPhase] = createSignal<Phase>({ kind: 'idle' })

  const probe = async (): Promise<void> => {
    setPhase({ kind: 'loading' })
    try {
      const outcome: ListSubtitleTracksOutcome = await listSubtitleTracks(
        props.folder,
        props.episodeId
      )
      if (!outcome.ok) {
        setPhase({
          kind: 'error',
          stderr: outcome.stderr,
          exitCode: outcome.exit_code ?? null
        })
        return
      }
      const selectableCount = outcome.tracks.filter(t => t.extractable).length
      if (selectableCount === 0) {
        setPhase({ kind: 'no-text', tracks: outcome.tracks })
        return
      }
      const initialIdx = pickInitialIndex(
        outcome.tracks,
        outcome.preselected_index ?? null,
        props.initialTrackId
      )
      setPhase({ kind: 'success', tracks: outcome.tracks, selectedIdx: initialIdx })
    } catch (err) {
      setPhase({
        kind: 'error',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null
      })
    }
  }

  createEffect(
    on(
      () => [props.open, props.episodeId] as const,
      ([open]) => {
        if (open) {
          void probe()
        } else {
          setPhase({ kind: 'idle' })
        }
      }
    )
  )

  const selectRow = (idx: number): void => {
    const cur = phase()
    if (cur.kind !== 'success') return
    const track = cur.tracks[idx]
    if (!track.extractable) return
    setPhase({ ...cur, selectedIdx: idx })
  }

  const confirm = async (): Promise<void> => {
    const cur = phase()
    if (cur.kind !== 'success' || cur.selectedIdx === null) return
    const track = cur.tracks[cur.selectedIdx]
    setPhase({ kind: 'saving', tracks: cur.tracks, selectedIdx: cur.selectedIdx })
    try {
      await setEpisodeSelectedTrack(
        props.episodeId,
        track.mkv_track_id,
        track.language || null
      )
      props.onClose()
    } catch {
      setPhase(cur)
    }
  }

  /** Reactive view-model for the table pane — `null` for non-table phases. */
  const tableViewModel = createMemo<TableViewModel | null>(() => {
    const cur = phase()
    switch (cur.kind) {
      case 'success':
        return { tracks: cur.tracks, selectedIdx: cur.selectedIdx, disabled: false }
      case 'saving':
        return { tracks: cur.tracks, selectedIdx: cur.selectedIdx, disabled: true }
      case 'no-text':
        return { tracks: cur.tracks, selectedIdx: null, disabled: true }
      default:
        return null
    }
  })

  const errorLogLines = createMemo<TerminalLogLine[]>(() => {
    const cur = phase()
    if (cur.kind !== 'error') return []
    return cur.stderr
      .split(/\r?\n/)
      .filter(l => l.length > 0)
      .map(text => ({ stream: 'stderr' as const, text }))
  })

  const errorExitCode = createMemo<number | null>(() => {
    const cur = phase()
    return cur.kind === 'error' ? cur.exitCode : null
  })

  const canConfirm = createMemo<boolean>(() => {
    const cur = phase()
    return cur.kind === 'success' && cur.selectedIdx !== null
  })

  const footer = (
    <Switch>
      <Match when={phase().kind === 'loading' || phase().kind === 'idle'}>
        <Button variant="secondary" onClick={() => props.onClose()} disabled>
          <span>Hủy</span>
        </Button>
      </Match>
      <Match when={phase().kind === 'error'}>
        <Button variant="secondary" onClick={() => props.onClose()}>
          <span>Đóng</span>
        </Button>
        <Button variant="primary" onClick={() => void probe()} aria-label="Thử lại">
          <RotateCw size={18} strokeWidth={1.5} aria-hidden="true" />
          <span>Thử lại</span>
        </Button>
      </Match>
      <Match when={phase().kind === 'no-text'}>
        <Button variant="secondary" onClick={() => props.onClose()}>
          <span>Đóng</span>
        </Button>
      </Match>
      <Match when={phase().kind === 'success'}>
        <Button variant="secondary" onClick={() => props.onClose()}>
          <span>Hủy</span>
        </Button>
        <Button
          variant="primary"
          onClick={() => void confirm()}
          disabled={!canConfirm()}
          aria-label="Chọn track này"
        >
          <span>Chọn track</span>
        </Button>
      </Match>
      <Match when={phase().kind === 'saving'}>
        <Button variant="secondary" onClick={() => props.onClose()} disabled>
          <span>Hủy</span>
        </Button>
        <Button variant="primary" disabled aria-label="Đang lưu">
          <Loader2 size={18} strokeWidth={1.5} class="animate-spin" aria-hidden="true" />
          <span>Đang lưu...</span>
        </Button>
      </Match>
    </Switch>
  )

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Chọn subtitle track"
      ariaLabel="Chọn subtitle track"
      footer={footer}
      maxWidthClass="max-w-3xl"
    >
      <div class="flex flex-col gap-5">
        <header class="flex flex-col gap-1">
          <span class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            EPISODE
          </span>
          <p class="break-all text-sm text-text">{props.episodeName}</p>
        </header>

        <Switch>
          <Match when={phase().kind === 'loading' || phase().kind === 'idle'}>
            <LoadingPane />
          </Match>
          <Match when={phase().kind === 'error'}>
            <ErrorPane lines={errorLogLines()} exitCode={errorExitCode()} />
          </Match>
          <Match when={tableViewModel() !== null}>
            <Show when={phase().kind === 'no-text'}>
              <div
                class="border-2 border-danger bg-bg px-3 py-2 text-sm text-danger"
                role="alert"
              >
                Không có subtitle track text-based trong file này.
              </div>
            </Show>
            <Show when={tableViewModel()}>
              {data => (
                <TracksTable
                  tracks={data().tracks}
                  selectedIdx={data().selectedIdx}
                  disabled={data().disabled}
                  onSelect={selectRow}
                />
              )}
            </Show>
          </Match>
        </Switch>
      </div>
    </Modal>
  )
}

const LoadingPane: Component = () => (
  <div
    class="flex min-h-[200px] flex-col items-center justify-center gap-3 border-2 border-border bg-bg px-6 py-12 text-center"
    role="status"
    aria-live="polite"
  >
    <Loader2
      size={28}
      strokeWidth={1.5}
      class="animate-spin text-text-muted"
      aria-hidden="true"
    />
    <p class="font-mono text-xs tracking-wide text-text-muted">Đang phân tích MKV...</p>
  </div>
)

interface ErrorPaneProps {
  lines: TerminalLogLine[]
  exitCode: number | null
}

const ErrorPane: Component<ErrorPaneProps> = props => (
  <div class="flex flex-col gap-3" role="alert">
    <p class="text-sm text-danger">
      mkvmerge thất bại
      <Show when={props.exitCode !== null}>
        <span class="font-mono text-text-muted"> (exit {props.exitCode})</span>
      </Show>
      . Kiểm tra file MKV còn tồn tại và bạn có quyền đọc.
    </p>
    <TerminalLog
      lines={props.lines}
      ariaLabel="Lỗi mkvmerge"
      emptyHint="mkvmerge không trả về thông báo lỗi."
    />
  </div>
)

interface TracksTableProps {
  tracks: SubtitleTrack[]
  selectedIdx: number | null
  disabled: boolean
  onSelect: (idx: number) => void
}

const TracksTable: Component<TracksTableProps> = props => {
  return (
    <div
      class="border-2 border-border bg-bg"
      role="region"
      aria-label="Danh sách subtitle track"
    >
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b-2 border-border">
            <th class="w-10 px-3 py-2" aria-label="Đã chọn"></th>
            <th class="w-14 px-3 py-2 text-left font-mono text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              #
            </th>
            <th class="w-24 px-3 py-2 text-left font-mono text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              Ngôn ngữ
            </th>
            <th class="w-32 px-3 py-2 text-left font-mono text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              Codec
            </th>
            <th class="px-3 py-2 text-left font-mono text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              Tiêu đề
            </th>
            <th class="w-40 px-3 py-2 text-left font-mono text-xs font-semibold tracking-[0.16em] text-text-muted uppercase">
              Cờ
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.tracks}>
            {(track, idx) => (
              <TrackRow
                track={track}
                isSelected={idx() === props.selectedIdx}
                isLast={idx() === props.tracks.length - 1}
                disabled={props.disabled}
                onSelect={() => props.onSelect(idx())}
              />
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

interface TrackRowProps {
  track: SubtitleTrack
  isSelected: boolean
  isLast: boolean
  disabled: boolean
  onSelect: () => void
}

const TrackRow: Component<TrackRowProps> = props => {
  const interactive = (): boolean => props.track.extractable && !props.disabled
  const handleClick = (): void => {
    if (!interactive()) return
    props.onSelect()
  }
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!interactive()) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      props.onSelect()
    }
  }

  return (
    <tr
      class={[
        props.isLast ? '' : 'border-b-2 border-border',
        interactive()
          ? `cursor-pointer transition-colors hover:bg-surface ${props.isSelected ? 'bg-surface' : ''}`
          : 'opacity-50'
      ].join(' ')}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={interactive() ? 'button' : undefined}
      tabIndex={interactive() ? 0 : -1}
      aria-disabled={!interactive()}
      aria-selected={props.isSelected}
    >
      <td class="w-10 px-3 py-3">
        <Show when={props.isSelected}>
          <Check
            size={18}
            strokeWidth={1.5}
            class="text-accent"
            aria-label="Track đã chọn"
          />
        </Show>
      </td>
      <td class="w-14 px-3 py-3 font-mono text-sm text-text">
        {props.track.mkv_track_id}
      </td>
      <td class="w-24 px-3 py-3 font-mono text-sm text-text uppercase">
        {props.track.language || 'und'}
      </td>
      <td class="w-32 px-3 py-3">
        <div class="flex flex-col gap-1">
          <span class="font-mono text-sm text-text uppercase">{props.track.codec}</span>
          <Show when={props.track.kind === 'bitmap'}>
            <StatusBadge tone="warn">Bitmap — không hỗ trợ</StatusBadge>
          </Show>
          <Show when={props.track.kind === 'other'}>
            <StatusBadge tone="warn">Không hỗ trợ</StatusBadge>
          </Show>
        </div>
      </td>
      <td class="px-3 py-3 text-sm text-text">
        <Show when={props.track.title} fallback={<span class="text-text-muted">—</span>}>
          {title => <span>{title()}</span>}
        </Show>
      </td>
      <td class="w-40 px-3 py-3">
        <div class="flex flex-wrap gap-1 font-mono text-[10px] uppercase tracking-wide">
          <Show when={props.track.is_default}>
            <span class="border-2 border-border bg-bg px-1.5 py-0.5 text-text-muted">
              Mặc định
            </span>
          </Show>
          <Show when={props.track.is_forced}>
            <span class="border-2 border-border bg-bg px-1.5 py-0.5 text-text-muted">
              Buộc
            </span>
          </Show>
          <Show when={!props.track.is_default && !props.track.is_forced}>
            <span class="text-text-muted">—</span>
          </Show>
        </div>
      </td>
    </tr>
  )
}

/**
 * Resolve the initial highlight for the picker on open.
 *
 * Precedence:
 *  1. Previously-saved selection (Đổi track flow), iff the track is
 *     still present in the freshly-probed list AND still extractable.
 *     This means "Đổi track" lands on the user's last pick by default
 *     even if the heuristic would have chosen differently.
 *  2. Backend's heuristic suggestion (`preselected_index`) from the
 *     three AC rules — already computed in pure Rust against the
 *     same `SubtitleTrack` list so frontend + backend stay in lockstep.
 *  3. `null` — caller shows the no-text state.
 */
function pickInitialIndex(
  tracks: SubtitleTrack[],
  heuristicIdx: number | null,
  previousTrackId: number | null
): number | null {
  if (previousTrackId !== null) {
    const idx = tracks.findIndex(t => t.mkv_track_id === previousTrackId && t.extractable)
    if (idx >= 0) return idx
  }
  return heuristicIdx
}

export default TrackPickerModal
