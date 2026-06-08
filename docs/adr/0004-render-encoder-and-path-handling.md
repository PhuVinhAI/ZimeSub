# Render uses auto-detected HW encoder with priority chain and runs in EpisodeFolder cwd

Hardware encoders vary by machine: Intel CPUs with iGPU expose QSV (`h264_qsv`), NVIDIA cards expose NVENC (`h264_nvenc`), modern AMD exposes AMF (`h264_amf`). Forcing QSV (as the user's example does) breaks on AMD-only or NVIDIA-only rigs. We probe `ffmpeg -hide_banner -encoders` on app start (and on Re-check) and pick the first available in the priority **QSV > NVENC > AMF > libx264 (CPU fallback)**; users may override per project. Quality knob is engine-specific (`-global_quality` for QSV, `-cq` for NVENC, `-quality` for AMF, `-crf` for libx264) — the UI exposes a single quality slider mapped per-engine.

ffmpeg's `subtitles=` filter on Windows mishandles drive letters and backslashes (`C\:\\Users\\...`) — the official escape is brittle. We avoid it entirely: every Render Job spawns ffmpeg with the **EpisodeFolder as cwd**, and the filter argument is just the relative `subtitles=vietsub.ass`. No path escaping required.

The Render output filename is always `<MKV_basename>.VietSub.mp4` (matches the user's reference output) so files copied out of the EpisodeFolder remain self-documenting.

## Consequences

- A `RenderConfig` lives at project-level (default) and may be overridden per Episode; both layers persist in `zimesub.json`.
- The job runner is responsible for resolving the EpisodeFolder absolute path and setting it as the process cwd before spawn — never bake absolute paths into filter strings.
- If a user picks an engine that isn't available on their machine (e.g. shared project config from another rig), the app must fall back to the highest-available engine with a one-time warning, not silently fail.
