import { invoke } from '@tauri-apps/api/core'

/**
 * TypeScript mirror of the Rust `tooling::ToolReport` shape. Field names
 * match the `#[derive(Serialize)]` output 1:1 — change both sides together.
 */

export type ToolName = 'mkvmerge' | 'mkvextract' | 'ffmpeg'

export type ToolStatus = 'Missing' | 'Outdated' | 'Ready'

export interface ToolReport {
  name: ToolName
  status: ToolStatus
  resolved_path: string | null
  detected_version: string | null
  minimum_version: string
}

/**
 * Detect required tools. Uses cached entries from `settings.json` when their
 * absolute paths still exist on disk; otherwise re-probes. Persists any
 * updates to the cache.
 *
 * Called once on app boot from `stores/tools` before the AppShell decides
 * whether to render the Onboarding gate.
 */
export async function toolProbe(): Promise<ToolReport[]> {
  return invoke<ToolReport[]>('tool_probe')
}

/**
 * Force a full re-detect, ignoring cached paths. Wired to the "Quét lại"
 * button in the Onboarding view.
 */
export async function toolRescan(): Promise<ToolReport[]> {
  return invoke<ToolReport[]>('tool_rescan')
}
