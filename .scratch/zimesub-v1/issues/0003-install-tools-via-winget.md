---
title: "Install tools via winget + live log stream + re-probe"
labels: [done]
type: AFK
blocked_by: [0002]
user_stories: [2, 3, 5, 6]
status: done
---

# 0003 — Install tools via winget + live log stream + re-probe

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## Status

**Done.** `cargo check --all-targets`, `cargo clippy --lib --all-targets --no-deps -- -D warnings`, `cargo test --lib` (10 tests passing — 3 new install tests + 7 existing tooling tests), `bun run lint` (lint:classes + eslint), and `bun run typecheck` all green. Verified on 2026-06-08.

## What to build

From the Onboarding view, clicking "Cài đặt" next to a Missing/Outdated `RequiredTool` spawns `winget install` for that tool. Stdout/stderr stream live into a monospace terminal-style log panel. When winget exits, `ToolProbe` re-runs automatically and the badge updates. If winget is unavailable, fall back to opening the official download page + a "Tôi đã cài" re-probe button.

## Acceptance criteria

- [x] Winget invocations: `winget install --id MKVToolNix.MKVToolNix -e --accept-package-agreements --accept-source-agreements` and `winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements`. Mkvmerge and mkvextract are both delivered by the MKVToolNix package; ffmpeg by Gyan.FFmpeg.
- [x] Stdout and stderr lines stream into the UI as produced (no buffering until exit). Log panel uses Geist Mono, fixed-pitch, auto-scrolls to bottom on each new line.
- [x] After winget exits (success or failure), `ToolProbe` re-runs. If the tool is now Ready, the badge flips and the gate is re-evaluated; if all 3 are Ready, Onboarding closes.
- [x] If `winget` itself is not on PATH (Win 10 pre-1809 or restricted enterprise), the install button is replaced by:
  - "Mở trang tải" — opens the official download URL via `tauri-plugin-opener`
  - "Tôi đã cài" — triggers `ToolProbe`
- [x] A "Quét lại" button in app Settings (reachable after Onboarding closes) re-runs detection without restart.
- [x] The app itself does NOT request UAC elevation. winget's per-install UAC prompt is intentional.
- [x] If a winget install fails (non-zero exit), the log panel stays visible with the captured error and a "Thử lại" button.
- [x] Cancelling an install kills the winget child process. Partial install state is left to winget — the app does not delete files.
- [x] All UI strings Vietnamese.

## Blocked by

- 0002

## Implementation notes

The backend grows by one Rust module (`install`) and three Tauri commands (`winget_available`, `tool_install_start`, `tool_install_cancel`). Streaming output flows through Tauri's built-in event bus: the supervisor task in `install::supervise` emits one `tool-install-log` event per line as `tokio::io::BufReader::lines()` yields it, and a single `tool-install-done` event when the process exits — no buffering. Two reader tasks drain stdout and stderr concurrently with `child.wait()` so a chatty stderr never blocks a slow stdout (and vice versa), and the `tokio::join!` on both readers runs *after* the wait so the UI sees every byte before the `done` event arrives.

Cancellation is built on `tokio::sync::Notify`: `start_install` stores one notifier per active install in `InstallRegistry` (a `Mutex<HashMap<install_id, …>>`), and `cancel_install` looks it up and calls `notify_waiters()`. The supervisor races the notifier against `child.wait()` inside `tokio::select! { biased; cancel_signal => …; wait_result => … }`, so the kill path always wins when both are ready. On cancel the supervisor calls `child.start_kill()` then awaits `child.wait()` to reap zombies, drains both readers, and emits a `done` event with `cancelled: true` — the UI distinguishes that from `success: false` so the banner copy can be appropriate. `Command::kill_on_drop(true)` is set as defence in depth in case the supervisor task itself panics.

The exact winget invocation is pinned in `install::winget_args` so the on-screen log shows the same flags the AC documents. `--disable-interactivity` is added on top of the AC's flag list so winget streams plain text instead of redrawing TUI widgets that would garble the terminal log. The first log line is the literal `> winget …` invocation so the user can copy-paste and reproduce. `CREATE_NO_WINDOW` is set on the child via `cmd.as_std_mut().creation_flags(0x0800_0000)` (the same pattern `tooling::read_version` uses) to suppress the brief console flash that would otherwise pop up before the UAC prompt.

Both mkvmerge and mkvextract are shipped by the same `MKVToolNix.MKVToolNix` winget package — `install::winget_package_id` maps both `RequiredTool` variants to that id. The frontend store mirrors the sibling relationship with a small `sharedPackageSiblings` table so clicking install on either row disables the other and shows the same "Đang cài..." state, even though only one winget process is actually running. A single install can therefore flip both badges from Missing → Ready in one shot.

Frontend tracks install state separately from probe state in `stores/tools`. The `install` slice (`phase`, `installId`, `tool`, `logs`, `exitCode`, `error`) is reset on each `startInstall` call and mutated by two long-lived Tauri event subscribers installed once during `bootstrapTools` (idempotent via a module-level promise so Solid's double-mount-in-dev never registers twice). When a `done` event arrives the store auto-fires `rescanTools()` regardless of success — winget may have left a partially-usable install behind even on non-zero exit, and a fresh probe is the only authoritative source of truth.

`TerminalLog` is a new design-system primitive that owns the auto-scroll behaviour: a `createEffect` on `() => props.lines.length` snaps `scrollTop = scrollHeight` whenever a new line is appended, with stderr lines tinted `warn` so failures stand out without misclassifying winget's routine stderr-progress noise. The `<pre>` per line preserves the `\n`-stripped winget output verbatim with `whitespace-pre-wrap break-words` so long URLs and download progress lines wrap instead of overflowing the panel horizontally. It's reused later by the Jobs panel (slice 0008) for ffmpeg/mkvextract stderr.

`Modal` is also a new design-system primitive that wires into the existing `modalStack` from slice 0001 — `useModal(closeFn)` on mount means the global `Escape` shortcut already pops it for free. The backdrop click also dismisses, and Tailwind v4's `bg-bg/92` opacity modifier on the custom `--color-bg` token produces the semi-opaque overlay called for by the style guide without breaking the no-blur / no-gradient rules. The same primitive will host the track picker, paste-translation textarea, and confirm dialogs in later slices.

Settings exposure is intentionally minimal in this slice: a gear icon on the StatusBar opens `SettingsModal`, which shows the cached `ToolReport` rows plus a "Quét lại" button wired to the same `rescanTools()` action the Onboarding view uses. This satisfies PRD user story 5 without prematurely building the full Settings surface (queue concurrency, default render config, etc.), which lands when those features need them.

The manual fallback path runs entirely through `tauri-plugin-opener`'s `openUrl` — `ToolRow` keeps a small lookup table of upstream download pages (MKVToolNix's Windows section and Gyan's FFmpeg builds) that match the same providers winget would have used, so a hand-installed user lands on the same builds. The two added capabilities — `opener:default` and `opener:allow-open-url` — are the minimum surface needed.

`install.rs` ships 3 unit tests covering the AC-pinned package ids, the AC-pinned argument vector, and the registry insert/remove round-trip. The async streaming + cancellation paths are integration-shaped (require a real child process) and are best left to manual verification + the eventual JobQueue integration tests in slice 0008.

### Files created

| File | Purpose |
|---|---|
| `src-tauri/src/install.rs` | winget install pipeline. `winget_available()` PATH probe, `start_install()` async spawn with two concurrent line readers emitting `tool-install-log` events, supervisor task racing `child.wait()` against a `tokio::sync::Notify` cancellation handle, `tool-install-done` event on completion. `InstallRegistry` holds per-install cancel handles. 3 unit tests. |
| `src/api/install.ts` | TS mirror of the install event payloads (`InstallLogEvent`, `InstallDoneEvent`) and `invoke()` bindings for `winget_available` / `tool_install_start` / `tool_install_cancel`, plus `onInstallLog` / `onInstallDone` typed `listen()` wrappers. |
| `src/api/opener.ts` | Thin wrapper over `@tauri-apps/plugin-opener`'s `openUrl` for the manual-download fallback. |
| `src/design-system/TerminalLog.tsx` | Mono-font auto-scrolling log panel. stderr tinted `warn`. Reusable — Jobs panel (slice 0008) will share it. |
| `src/design-system/Modal.tsx` | Centered modal primitive with backdrop click dismiss, Escape shortcut via existing `modalStack`, optional title + footer slots. |
| `src/views/settings/SettingsModal.tsx` | Settings modal — read-only `ToolReport` rows + the "Quét lại" button required by AC (post-Onboarding re-probe entry point). |

### Files modified

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Added `tauri-plugin-opener = "2"` and `tokio = "1"` (features `process`, `io-util`, `macros`, `sync`, `rt`) as direct deps. |
| `src-tauri/Cargo.lock` | Lockfile updates for the new deps (tauri-plugin-opener + its `open` / `zbus` graph). |
| `src-tauri/src/lib.rs` | Registers the new `install` module, the `tauri_plugin_opener::init()` plugin, and the three new Tauri commands. |
| `src-tauri/src/commands.rs` | Adds `winget_available`, `tool_install_start`, `tool_install_cancel`. `AppState` extended with `Arc<InstallRegistry>` for the install handle map. |
| `src-tauri/capabilities/default.json` | Added `opener:default` and `opener:allow-open-url` permissions for the manual-download fallback. |
| `package.json` | Added `@tauri-apps/plugin-opener` ^2.5.4. |
| `bun.lockb` | Updated for the new opener dep. |
| `src/stores/tools.ts` | Added `wingetAvailable` + `install` slices (phase, logs, exit code, error). New actions `startInstall` / `cancelInstall` / `clearInstallState` / `manualReprobe` and selectors `isInstallingTool` / `isLastInstallForTool` that handle the mkvmerge↔mkvextract shared-package case. `bootstrapTools` now also binds the two install event subscribers (idempotent) and seeds `wingetAvailable`. `handleDone` auto-fires `rescanTools` so the Onboarding gate re-evaluates on its own. |
| `src/views/onboarding/ToolRow.tsx` | Adds the install / cancel / retry / "Mở trang tải" / "Tôi đã cài" action cluster per row, with cross-row install lockout, sibling-package awareness, and lucide icons (`Download`, `ExternalLink`, `RefreshCw`, `X`). |
| `src/views/onboarding/OnboardingView.tsx` | Renders the new `TerminalLog` panel below the rows when an install is or was active, with completion banner (success / failed / cancelled), "Đóng nhật ký" reset, and a winget-missing warning bar above. "Quét lại" demoted from primary to secondary now that "Cài đặt" is the per-row primary CTA. |
| `src/components/shell/StatusBar.tsx` | Adds the right-edge gear icon trigger that opens `SettingsModal` — the post-Onboarding re-probe entry point required by AC. |
| `src/components/shell/AppShell.tsx` | Mounts `SettingsModal` alongside `StatusBar` when all tools are Ready; carries the `open` signal + handlers. |

### Files deleted

None.
