import type { ExtractAudioConfig, RenderConfig } from '@api/projects'
import {
  ENCODER_LABELS,
  encoderProbeGetCached,
  encoderProbeRescan,
  type EncoderKey,
  type EncoderProbeOutcome
} from '@api/render'
import Button from '@design-system/Button'
import Modal from '@design-system/Modal'
import { pushAccentToast, pushDangerToast } from '@lib/toast/toastStore'
import {
  projectsStore,
  setDefaultRenderConfig,
  setExtractAudioConfig
} from '@stores/projects'
import { RefreshCw } from 'lucide-solid'
import { createEffect, createSignal, For, on, Show, type Component } from 'solid-js'

/**
 * Project-level settings modal. Slice 0009 ships the "Trích xuất
 * audio" sub-form here:
 *  - Codec dropdown (libmp3lame / aac / flac)
 *  - Quality input
 *    * mp3 → `q:a 0..9` VBR (0 = highest, 9 = lowest)
 *    * aac → `b:a NNNk` bitrate
 *    * flac → no extra param (lossless)
 *
 * Slice 0011 adds the "Render" sub-form:
 *  - Encoder dropdown ("auto" + one entry per available_encoder)
 *  - Quality slider 0..100 (default 65)
 *  - Audio bitrate input (default 192 kbps; codec fixed to aac in v1)
 *  - "Quét lại encoder" button next to the dropdown so the user can
 *    refresh the list after installing/upgrading ffmpeg.
 *
 * Mounted as a sibling to the app-level SettingsModal so the user can
 * tell at a glance which scope a tweak applies to: gear-on-project-row
 * = per-project, gear-on-status-bar = app-wide.
 */
interface ProjectSettingsModalProps {
  open: boolean
  onClose: () => void
}

type CodecOption = 'libmp3lame' | 'aac' | 'flac'

const CODEC_LABELS: Record<CodecOption, string> = {
  libmp3lame: 'MP3 (libmp3lame)',
  aac: 'AAC',
  flac: 'FLAC (lossless)'
}

type EncoderChoice = 'auto' | EncoderKey

const ProjectSettingsModal: Component<ProjectSettingsModalProps> = props => {
  const [codec, setCodec] = createSignal<CodecOption>('libmp3lame')
  const [mp3Quality, setMp3Quality] = createSignal('2')
  const [aacBitrate, setAacBitrate] = createSignal('192')
  const [encoder, setEncoder] = createSignal<EncoderChoice>('auto')
  const [renderQuality, setRenderQuality] = createSignal(65)
  const [renderAudioBitrate, setRenderAudioBitrate] = createSignal('192')
  const [availableEncoders, setAvailableEncoders] = createSignal<EncoderKey[]>([])
  const [probing, setProbing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  // Hydrate from the active project whenever the modal opens. Re-runs
  // when the user re-opens after switching projects so the form
  // reflects the just-opened project's config.
  createEffect(
    on(
      () => props.open,
      open => {
        if (!open) return
        const active = projectsStore.active
        if (!active) return
        applyAudioConfig(active.default_extract_audio)
        applyRenderConfig(active.default_render_config)
        void loadCachedEncoders()
      }
    )
  )

  const loadCachedEncoders = async (): Promise<void> => {
    try {
      const outcome = await encoderProbeGetCached()
      setAvailableEncoders(outcome.available_encoders)
    } catch {
      // Cache miss is non-fatal — the dropdown shows just "Auto".
    }
  }

  const handleProbe = async (): Promise<void> => {
    if (probing()) return
    setProbing(true)
    try {
      const outcome: EncoderProbeOutcome = await encoderProbeRescan()
      setAvailableEncoders(outcome.available_encoders)
      if (outcome.available_encoders.length === 0) {
        pushDangerToast('Không phát hiện encoder H.264 nào từ ffmpeg.')
      } else {
        pushAccentToast(`Đã phát hiện ${outcome.available_encoders.length} encoder.`)
      }
    } catch (err) {
      pushDangerToast(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }

  const applyAudioConfig = (cfg: ExtractAudioConfig): void => {
    const c = (cfg.codec as CodecOption) ?? 'libmp3lame'
    setCodec(['libmp3lame', 'aac', 'flac'].includes(c) ? c : 'libmp3lame')
    // Pre-fill both quality fields so the user can toggle the codec
    // dropdown without losing a previously-entered value.
    setMp3Quality(parseMp3Quality(cfg.quality_or_bitrate) ?? '2')
    setAacBitrate(parseAacBitrate(cfg.quality_or_bitrate) ?? '192')
  }

  const applyRenderConfig = (cfg: RenderConfig): void => {
    const enc = cfg.encoder as EncoderChoice
    const knownEncoders: EncoderChoice[] = [
      'auto',
      'h264_qsv',
      'h264_nvenc',
      'h264_amf',
      'libx264'
    ]
    setEncoder(knownEncoders.includes(enc) ? enc : 'auto')
    setRenderQuality(clampInt(String(cfg.quality), 0, 100, 65))
    setRenderAudioBitrate(String(clampInt(String(cfg.audio_bitrate_kbps), 32, 512, 192)))
  }

  const buildAudioConfig = (): ExtractAudioConfig => {
    const c = codec()
    if (c === 'libmp3lame') {
      const q = clampInt(mp3Quality(), 0, 9, 2)
      return { codec: c, quality_or_bitrate: `q:a ${q}` }
    }
    if (c === 'aac') {
      const kbps = clampInt(aacBitrate(), 32, 512, 192)
      return { codec: c, quality_or_bitrate: `b:a ${kbps}k` }
    }
    return { codec: 'flac', quality_or_bitrate: '' }
  }

  const buildRenderConfig = (): RenderConfig => ({
    encoder: encoder(),
    quality: clampInt(String(renderQuality()), 0, 100, 65),
    audio_codec: 'aac',
    audio_bitrate_kbps: clampInt(renderAudioBitrate(), 32, 512, 192)
  })

  const handleSave = async (): Promise<void> => {
    if (saving()) return
    setSaving(true)
    try {
      await setExtractAudioConfig(buildAudioConfig())
      await setDefaultRenderConfig(buildRenderConfig())
      props.onClose()
    } catch (err) {
      pushDangerToast(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={() => props.onClose()} aria-label="Hủy">
        <span>Hủy</span>
      </Button>
      <Button
        variant="primary"
        onClick={() => void handleSave()}
        disabled={saving()}
        aria-label="Lưu cấu hình project"
      >
        <span>{saving() ? 'Đang lưu…' : 'Lưu'}</span>
      </Button>
    </>
  )

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Cấu hình project"
      ariaLabel="Cấu hình project"
      footer={footer}
    >
      <div class="flex flex-col gap-8">
        <section class="flex flex-col gap-4" aria-label="Cấu hình trích xuất audio">
          <h3 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            TRÍCH XUẤT AUDIO
          </h3>

          <div class="border-2 border-border bg-bg px-4 py-4">
            <div class="flex flex-col gap-4">
              <div class="flex flex-col gap-2">
                <label for="audio-codec" class="font-mono text-sm font-medium text-text">
                  Codec
                </label>
                <select
                  id="audio-codec"
                  value={codec()}
                  onChange={e => setCodec(e.currentTarget.value as CodecOption)}
                  class="h-11 border-2 border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent"
                  aria-label="Codec audio"
                >
                  <option value="libmp3lame">{CODEC_LABELS.libmp3lame}</option>
                  <option value="aac">{CODEC_LABELS.aac}</option>
                  <option value="flac">{CODEC_LABELS.flac}</option>
                </select>
              </div>

              <Show when={codec() === 'libmp3lame'}>
                <div class="flex flex-col gap-2">
                  <label
                    for="audio-mp3-quality"
                    class="font-mono text-sm font-medium text-text"
                  >
                    Chất lượng (q:a)
                  </label>
                  <p class="text-xs text-text-muted">
                    0 = chất lượng cao nhất, 9 = thấp nhất. Mặc định: 2.
                  </p>
                  <input
                    id="audio-mp3-quality"
                    type="number"
                    min={0}
                    max={9}
                    value={mp3Quality()}
                    onInput={e => setMp3Quality(e.currentTarget.value)}
                    class="h-11 w-24 border-2 border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent"
                    aria-label="Chất lượng VBR mp3"
                  />
                </div>
              </Show>

              <Show when={codec() === 'aac'}>
                <div class="flex flex-col gap-2">
                  <label
                    for="audio-aac-bitrate"
                    class="font-mono text-sm font-medium text-text"
                  >
                    Bitrate (kbps)
                  </label>
                  <p class="text-xs text-text-muted">
                    Khoảng hợp lệ: 32–512 kbps. Mặc định: 192 kbps.
                  </p>
                  <input
                    id="audio-aac-bitrate"
                    type="number"
                    min={32}
                    max={512}
                    value={aacBitrate()}
                    onInput={e => setAacBitrate(e.currentTarget.value)}
                    class="h-11 w-24 border-2 border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent"
                    aria-label="Bitrate aac"
                  />
                </div>
              </Show>

              <Show when={codec() === 'flac'}>
                <p class="text-xs text-text-muted">
                  FLAC là codec lossless — không cần thông số chất lượng.
                </p>
              </Show>
            </div>
          </div>
        </section>

        <section class="flex flex-col gap-4" aria-label="Cấu hình render">
          <h3 class="font-mono text-xs font-semibold tracking-[0.18em] text-text-muted">
            RENDER (HARDSUB)
          </h3>

          <div class="border-2 border-border bg-bg px-4 py-4">
            <div class="flex flex-col gap-4">
              <div class="flex flex-col gap-2">
                <div class="flex items-end justify-between gap-2">
                  <label
                    for="render-encoder"
                    class="font-mono text-sm font-medium text-text"
                  >
                    Encoder
                  </label>
                  <Button
                    variant="secondary"
                    onClick={() => void handleProbe()}
                    disabled={probing()}
                    aria-label="Quét lại encoder khả dụng"
                  >
                    <RefreshCw
                      size={16}
                      strokeWidth={1.5}
                      aria-hidden="true"
                      class={probing() ? 'animate-spin' : ''}
                    />
                    <span>{probing() ? 'Đang quét…' : 'Quét lại'}</span>
                  </Button>
                </div>
                <select
                  id="render-encoder"
                  value={encoder()}
                  onChange={e => setEncoder(e.currentTarget.value as EncoderChoice)}
                  class="h-11 border-2 border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent"
                  aria-label="Encoder hardware/CPU"
                >
                  <option value="auto">Auto (theo thứ tự ưu tiên)</option>
                  <For each={availableEncoders()}>
                    {key => <option value={key}>{ENCODER_LABELS[key]}</option>}
                  </For>
                </select>
                <Show when={availableEncoders().length === 0}>
                  <p class="text-xs text-warn">
                    Chưa dò encoder. Nhấn "Quét lại" sau khi ffmpeg đã cài.
                  </p>
                </Show>
              </div>

              <div class="flex flex-col gap-2">
                <label
                  for="render-quality"
                  class="font-mono text-sm font-medium text-text"
                >
                  Chất lượng: {renderQuality()}
                </label>
                <p class="text-xs text-text-muted">
                  0 = nhỏ/nhanh nhất, 100 = chất lượng cao nhất. Map theo từng encoder
                  (QSV/NVENC/libx264 = số 28→18; AMF = speed/balanced/quality).
                </p>
                <input
                  id="render-quality"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={renderQuality()}
                  onInput={e =>
                    setRenderQuality(Number.parseInt(e.currentTarget.value, 10) || 0)
                  }
                  class="h-11 w-full accent-accent"
                  aria-label="Chất lượng render"
                />
              </div>

              <div class="flex flex-col gap-2">
                <label
                  for="render-audio-bitrate"
                  class="font-mono text-sm font-medium text-text"
                >
                  Audio AAC bitrate (kbps)
                </label>
                <p class="text-xs text-text-muted">
                  Codec audio luôn là <span class="font-mono text-text">aac</span> trong
                  v1. Khoảng hợp lệ: 32–512 kbps.
                </p>
                <input
                  id="render-audio-bitrate"
                  type="number"
                  min={32}
                  max={512}
                  value={renderAudioBitrate()}
                  onInput={e => setRenderAudioBitrate(e.currentTarget.value)}
                  class="h-11 w-24 border-2 border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent"
                  aria-label="Bitrate audio render"
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  )
}

function parseMp3Quality(value: string): string | null {
  const m = value.trim().match(/^q:a\s+(\d+)$/i)
  if (!m) return null
  return m[1]
}

function parseAacBitrate(value: string): string | null {
  const m = value.trim().match(/^b:a\s+(\d+)k$/i)
  if (!m) return null
  return m[1]
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export default ProjectSettingsModal
