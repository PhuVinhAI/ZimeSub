# Detect external tools, install via winget, never embed

ZimeSub depends on `mkvmerge`, `mkvextract` (MKVToolNix) and `ffmpeg`. We considered embedding these binaries in the app installer, using scoop/choco, or showing a manual download page — but settled on:

1. **Detect**: try the tool via `PATH` first, then fall back to the platform-default install path (e.g. `C:\Program Files\MKVToolNix\mkvmerge.exe`). Cache the discovered absolute path in app settings so we don't re-probe on every launch.
2. **Install**: drive `winget install MKVToolNix.MKVToolNix` and `winget install Gyan.FFmpeg` from the Onboarding view, streaming stdout/stderr into a terminal-style log panel so the user sees real progress.
3. **Manual fallback**: if winget is unavailable (Windows 10 pre-1809, locked-down enterprise machines), open the official download page and show a "Re-check tools" button.
4. **Version floor**: require `ffmpeg ≥ 4.0` (for `h264_qsv`) and `MKVToolNix ≥ 60.0`. Below the floor → block and prompt upgrade.

Embedding was rejected because shipping ffmpeg balloons the installer by ~120 MB, complicates LGPL compliance for redistribution, and prevents users from benefiting from upstream security/feature updates. Embedding MKVToolNix similarly bundles a binary we cannot patch independently.

## Consequences

- The app must implement a robust onboarding gate that blocks all other UI until both tools are present at acceptable versions.
- Tool paths are first-class state in app settings; any code that shells out reads from this cache, never assumes a global `mkvmerge` on PATH.
- A "Re-check tools" action must exist in settings so users who install tools while the app is open don't need to relaunch.
