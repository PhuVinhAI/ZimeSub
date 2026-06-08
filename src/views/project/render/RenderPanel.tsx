import type { RenderConfig } from '@api/projects'
import {
  ENCODER_LABELS,
  encoderProbeGetCached,
  episodeGetEffectiveRenderConfig,
  type EncoderKey
} from '@api/render'
import Button from '@design-system/Button'
import ProgressBar from '@design-system/ProgressBar'
import { pushDangerToast } from '@lib/toast/toastStore'
import { artifactStateFor, cancelRender, jobStateFor, startRender } from '@stores/jobs'
import { projectsStore, setRenderConfigOverride } from '@stores/projects'
import {
  ChevronDown,
  ChevronRight,
  Film,
  Loader2,
  RotateCw,
  Settings2
} from 'lucide-solid'
import { createEffect, createSignal, For, on, Show, type Component } from 'solid-js'

/**
 * Per-Episode Render strip — slice 0011.
 *
 * Mounted by `ProjectView`'s `EpisodeRow` below the TranslatePanel
 * when the Episode has a TranslatedSub on disk (`<basename>.vietsub.ass`).
 *
 * Contents:
 *  - "Render" CTA — primary button, kicks the Render job.
 *  - Progress bar + "Hủy" while a render is running.
 *  - "Render lỗi thời" badge (slice 0010 already lights the flag —
 *    we surface a refresh button here so the user can re-render in
 *    one click without leaving the row).
 *  - Collapsible "Cấu hình override" section — encoder + quality
 *    slider + audio bitrate that override the project default for
 *    this Episode only. "Khôi phục mặc định" clears the override.
 */
interface RenderPanelProps {
  episodeId: string
  episodeName: string
}

type EncoderChoice = 'auto' | EncoderKey

const KNOWN_ENCODERS: EncoderChoice[] = [
  'auto',
  'h264_qsv',
  'h264_nvenc',
  'h264_amf',
  'libx264'
]

const RenderPanel: Component<RenderPanelProps> = props => {
  const [overrideOpen, setOverrideOpen] = createSignal(false)

  const job = () => jobStateFor(props.episodeId, 'render')
  const artifacts = () => artifactStateFor(props.episodeId)
  const hasRender = () => artifacts()?.hasRender ?? false
  const isStale = () => artifacts()?.isRenderStale ?? false
  /** Slice 0012 — disable Render when SourceMkv has gone missing. */
  const isSourceMissing = () => artifacts()?.isSourceMissing ?? false

  const isQueued = (): boolean => job().phase === 'queued'
  const isRunning = (): boolean => job().phase === 'running'
  const isFailed = (): boolean => job().phase === 'failed'
  const isInFlight = (): boolean => isQueued() || isRunning()

  return (
    <div class="mt-4 flex flex-col gap-3 border-t-2 border-border pt-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <h3 class="font-mono text-[11px] font-semibold tracking-[0.18em] text-text-muted">
            RENDER
          </h3>
          <Show when={hasRender() && !isStale() && !isInFlight()}>
            <span
              class="inline-flex items-center gap-1.5 border-2 border-accent bg-bg px-2.5 py-1 font-mono text-xs font-medium tracking-wide text-accent uppercase"
              aria-label="Episode đã có file Render"
            >
              Đã render
            </span>
          </Show>
          <Show when={hasRender() && isStale() && !isInFlight()}>
            <span
              class="inline-flex items-center gap-1.5 border-2 border-warn bg-bg px-2.5 py-1 font-mono text-xs font-medium tracking-wide text-warn uppercase"
              aria-label="Render lỗi thời — TranslatedSub mới hơn"
              title="TranslatedSub mới hơn bản render — cần render lại"
            >
              Render lỗi thời
            </span>
          </Show>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Show when={isInFlight()}>
            <div class="flex w-48 items-center gap-2">
              <ProgressBar
                ratio={job().ratio}
                ariaLabel="Đang render Episode"
                ariaValueText={job().hint || `${Math.round(job().ratio * 100)}%`}
              />
              <span class="w-24 text-right font-mono text-[11px] text-text-muted">
                {job().hint || `${Math.round(job().ratio * 100)}%`}
              </span>
            </div>
            <Button
              variant="secondary"
              onClick={() => void cancelRender(props.episodeId)}
              aria-label="Hủy job render đang chạy"
            >
              <Loader2
                size={16}
                strokeWidth={1.5}
                class="animate-spin"
                aria-hidden="true"
              />
              <span>Hủy</span>
            </Button>
          </Show>

          <Show when={!isInFlight() && isFailed()}>
            <Button
              variant="primary"
              onClick={() => void startRender(props.episodeId)}
              disabled={isSourceMissing()}
              title={isSourceMissing() ? 'MKV gốc không tìm thấy' : undefined}
              aria-label="Thử render lại"
            >
              <RotateCw size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Thử lại</span>
            </Button>
          </Show>

          <Show when={!isInFlight() && !isFailed()}>
            <Button
              variant="primary"
              onClick={() => void startRender(props.episodeId)}
              disabled={isSourceMissing()}
              title={isSourceMissing() ? 'MKV gốc không tìm thấy' : undefined}
              aria-label="Bắt đầu render cho Episode này"
            >
              <Film size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>{hasRender() ? 'Render lại' : 'Render'}</span>
            </Button>
          </Show>

          <button
            type="button"
            onClick={() => setOverrideOpen(prev => !prev)}
            class="inline-flex h-11 items-center gap-1 border-2 border-border bg-bg px-3 font-mono text-xs text-text-muted transition-colors hover:border-accent hover:text-accent"
            aria-expanded={overrideOpen()}
            aria-label="Mở rộng cấu hình override"
          >
            <Show
              when={overrideOpen()}
              fallback={<ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />}
            >
              <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
            </Show>
            <Settings2 size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>Cấu hình override</span>
          </button>
        </div>
      </div>

      <Show when={overrideOpen()}>
        <OverrideForm episodeId={props.episodeId} />
      </Show>
    </div>
  )
}

interface OverrideFormProps {
  episodeId: string
}

const OverrideForm: Component<OverrideFormProps> = props => {
  const [encoder, setEncoder] = createSignal<EncoderChoice>('auto')
  const [quality, setQuality] = createSignal(65)
  const [audioBitrate, setAudioBitrate] = createSignal('192')
  const [availableEncoders, setAvailableEncoders] = createSignal<EncoderKey[]>([])
  const [saving, setSaving] = createSignal(false)
  const [hasOverride, setHasOverride] = createSignal(false)

  createEffect(
    on(
      () => props.episodeId,
      async episodeId => {
        const folder = projectsStore.activeFolder
        if (!folder || !episodeId) return
        try {
          const cached = await encoderProbeGetCached()
          setAvailableEncoders(cached.available_encoders)
        } catch {
          // Cache miss → only "auto" stays in the dropdown.
        }
        const ep = projectsStore.active?.episodes.find(e => e.id === episodeId)
        const explicitOverride = ep?.render_config_override ?? null
        setHasOverride(explicitOverride !== null)
        try {
          // Boot the form with the effective config so the slider
          // reflects what the next render would actually use, even
          // before an override has been saved.
          const effective = await episodeGetEffectiveRenderConfig(folder, episodeId)
          applyConfig(effective)
        } catch (err) {
          pushDangerToast(err instanceof Error ? err.message : String(err))
        }
      }
    )
  )

  const applyConfig = (cfg: RenderConfig): void => {
    const enc = cfg.encoder as EncoderChoice
    setEncoder(KNOWN_ENCODERS.includes(enc) ? enc : 'auto')
    setQuality(clampInt(String(cfg.quality), 0, 100, 65))
    setAudioBitrate(String(clampInt(String(cfg.audio_bitrate_kbps), 32, 512, 192)))
  }

  const buildConfig = (): RenderConfig => ({
    encoder: encoder(),
    quality: clampInt(String(quality()), 0, 100, 65),
    audio_codec: 'aac',
    audio_bitrate_kbps: clampInt(audioBitrate(), 32, 512, 192)
  })

  const handleSave = async (): Promise<void> => {
    if (saving()) return
    setSaving(true)
    try {
      await setRenderConfigOverride(props.episodeId, buildConfig())
      setHasOverride(true)
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    if (saving()) return
    setSaving(true)
    try {
      await setRenderConfigOverride(props.episodeId, null)
      setHasOverride(false)
      const folder = projectsStore.activeFolder
      if (folder) {
        try {
          const effective = await episodeGetEffectiveRenderConfig(folder, props.episodeId)
          applyConfig(effective)
        } catch {
          // Best-effort.
        }
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 border-2 border-border bg-bg px-4 py-4">
      <p class="text-xs text-text-muted">
        Override sẽ thay thế cấu hình mặc định của project chỉ với Episode này.
      </p>
      <div class="flex flex-wrap gap-4">
        <div class="flex min-w-[220px] flex-1 flex-col gap-1">
          <label
            for={`override-encoder-${props.episodeId}`}
            class="font-mono text-xs font-medium text-text"
          >
            Encoder
          </label>
          <select
            id={`override-encoder-${props.episodeId}`}
            value={encoder()}
            onChange={e => setEncoder(e.currentTarget.value as EncoderChoice)}
            class="h-10 border-2 border-border bg-bg px-3 font-mono text-xs text-text outline-none focus:border-accent"
            aria-label="Encoder override"
          >
            <option value="auto">Auto</option>
            <For each={availableEncoders()}>
              {key => <option value={key}>{ENCODER_LABELS[key]}</option>}
            </For>
          </select>
        </div>

        <div class="flex min-w-[200px] flex-1 flex-col gap-1">
          <label
            for={`override-quality-${props.episodeId}`}
            class="font-mono text-xs font-medium text-text"
          >
            Chất lượng: {quality()}
          </label>
          <input
            id={`override-quality-${props.episodeId}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={quality()}
            onInput={e => setQuality(Number.parseInt(e.currentTarget.value, 10) || 0)}
            class="h-10 w-full accent-accent"
            aria-label="Chất lượng render override"
          />
        </div>

        <div class="flex min-w-[140px] flex-col gap-1">
          <label
            for={`override-bitrate-${props.episodeId}`}
            class="font-mono text-xs font-medium text-text"
          >
            Audio AAC (kbps)
          </label>
          <input
            id={`override-bitrate-${props.episodeId}`}
            type="number"
            min={32}
            max={512}
            value={audioBitrate()}
            onInput={e => setAudioBitrate(e.currentTarget.value)}
            class="h-10 w-24 border-2 border-border bg-bg px-3 font-mono text-xs text-text outline-none focus:border-accent"
            aria-label="Bitrate audio override"
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saving()}
          aria-label="Lưu cấu hình override"
        >
          <span>{saving() ? 'Đang lưu…' : 'Lưu override'}</span>
        </Button>
        <Show when={hasOverride()}>
          <Button
            variant="secondary"
            onClick={() => void handleClear()}
            disabled={saving()}
            aria-label="Khôi phục cấu hình mặc định project"
          >
            <span>Khôi phục mặc định</span>
          </Button>
        </Show>
      </div>
    </div>
  )
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export default RenderPanel
