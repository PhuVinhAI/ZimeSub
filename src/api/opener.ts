import { openUrl as pluginOpenUrl } from '@tauri-apps/plugin-opener'

/**
 * Open a URL in the user's default browser via `tauri-plugin-opener`.
 *
 * Used by the Onboarding "Mở trang tải" fallback when winget is not
 * available — the manual download path for MKVToolNix and Gyan.FFmpeg.
 */
export async function openUrl(url: string): Promise<void> {
  await pluginOpenUrl(url)
}
