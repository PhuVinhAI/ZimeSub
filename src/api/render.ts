import type { ProjectJson, RenderConfig } from '@api/projects'
import { invoke } from '@tauri-apps/api/core'

/**
 * Render-stage command bindings — slice 0011.
 *
 * EncoderProbe cache, project-level + per-Episode RenderConfig
 * read/write, and the render job lifecycle (`render_start` /
 * `render_cancel`). Field names mirror the Rust `#[derive(Serialize)]`
 * outputs 1:1.
 */

/** Canonical ffmpeg encoder key from the priority list. */
export type EncoderKey = 'h264_qsv' | 'h264_nvenc' | 'h264_amf' | 'libx264'

/** Cached EncoderProbe result returned from the backend. */
export interface EncoderProbeOutcome {
  available_encoders: EncoderKey[]
}

/**
 * Render-start outcome — the runner has been enqueued and the
 * encoder resolution has produced this answer.
 *
 * `fallback_from` is `null` when the configured encoder was available
 * (or `auto` was used); non-null when the picker dropped to the
 * highest-available encoder because the saved choice wasn't on this
 * machine. The UI surfaces a one-time warn toast in that case (AC).
 */
export interface RenderStartOutcome {
  chosen_encoder: EncoderKey
  fallback_from: EncoderKey | null
}

/** Vietnamese label for each known encoder — used in the dropdown. */
export const ENCODER_LABELS: Record<EncoderKey, string> = {
  h264_qsv: 'Intel QSV (h264_qsv)',
  h264_nvenc: 'NVIDIA NVENC (h264_nvenc)',
  h264_amf: 'AMD AMF (h264_amf)',
  libx264: 'CPU (libx264)'
}

/**
 * Read the cached EncoderProbe result from settings. Returns the
 * empty list when the probe has never run on this install — the UI
 * surfaces a "Quét encoder" CTA in that case.
 */
export async function encoderProbeGetCached(): Promise<EncoderProbeOutcome> {
  return invoke<EncoderProbeOutcome>('encoder_probe_get_cached')
}

/**
 * Re-run the EncoderProbe (spawns `ffmpeg -encoders`) and persist
 * the result into `settings.available_encoders`. Drives the
 * "Quét lại encoder" button.
 */
export async function encoderProbeRescan(): Promise<EncoderProbeOutcome> {
  return invoke<EncoderProbeOutcome>('encoder_probe_rescan')
}

/**
 * Read the project's `default_render_config`. Drives the Settings
 * modal render sub-form on open.
 */
export async function projectGetRenderConfig(folder: string): Promise<RenderConfig> {
  return invoke<RenderConfig>('project_get_render_config', { folder })
}

/**
 * Persist a new `default_render_config`. Returns the post-write
 * project so the projects store can swap `active` without a second
 * `project_open` round-trip.
 */
export async function projectSetRenderConfig(
  folder: string,
  config: RenderConfig
): Promise<ProjectJson> {
  return invoke<ProjectJson>('project_set_render_config', { folder, config })
}

/**
 * Read the effective render config for one Episode (override if
 * present, project default otherwise). Used by the per-Episode "Cấu
 * hình override" form so the inputs boot with the actual settings
 * the next render would use.
 */
export async function episodeGetEffectiveRenderConfig(
  folder: string,
  episodeId: string
): Promise<RenderConfig> {
  return invoke<RenderConfig>('episode_get_effective_render_config', {
    folder,
    episodeId
  })
}

/**
 * Persist a per-Episode `render_config_override`. Passing `null`
 * clears the override (restoring the project default). Returns the
 * post-write project.
 */
export async function episodeSetRenderConfigOverride(
  folder: string,
  episodeId: string,
  config: RenderConfig | null
): Promise<ProjectJson> {
  return invoke<ProjectJson>('episode_set_render_config_override', {
    folder,
    episodeId,
    config
  })
}

/**
 * Enqueue a fresh `Render` job. Returns the resolved encoder result
 * so the UI can surface the one-time fallback toast when the saved
 * config wasn't on this machine.
 *
 * Rejects with "Cần TranslatedSub trước" when `<basename>.vietsub.ass`
 * is missing, "Chưa phát hiện đường dẫn ffmpeg" when ffmpeg isn't
 * cached, and a Vietnamese message when no encoders are available.
 */
export async function renderStart(
  jobId: string,
  folder: string,
  episodeId: string
): Promise<RenderStartOutcome> {
  return invoke<RenderStartOutcome>('render_start', {
    jobId,
    folder,
    episodeId
  })
}

/**
 * Cancel a queued or running render job — backwards-compat path.
 * New code should prefer the generic `jobCancel` from `@api/jobs.ts`.
 */
export async function renderCancel(jobId: string): Promise<void> {
  return invoke<void>('render_cancel', { jobId })
}
