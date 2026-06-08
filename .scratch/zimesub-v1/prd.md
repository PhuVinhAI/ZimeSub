# PRD — ZimeSub v1

> Source of truth glossary: [`CONTEXT.md`](../../CONTEXT.md)
> Architectural decisions: [`docs/adr/0001`](../../docs/adr/0001-source-mkv-path-only.md), [`0002`](../../docs/adr/0002-tooling-via-winget.md), [`0003`](../../docs/adr/0003-tiered-job-queue.md), [`0004`](../../docs/adr/0004-render-encoder-and-path-handling.md)
> UI specs: [`docs/style-guide.md`](../../docs/style-guide.md)

## Problem Statement

Tôi làm phụ đề tiếng Việt cho anime. Workflow hiện tại của tôi rời rạc và lặp đi lặp lại — mỗi tập tôi phải:

- Mở Explorer, tìm MKV, copy đường dẫn
- Mở Command Prompt, gõ `mkvmerge -i ...` để check sub track
- Gõ `mkvextract tracks ... 2:eng.ass` để xuất subtitle
- Gõ `ffmpeg -i ... -vn -c:a libmp3lame ...` để xuất audio cho QC
- Đổi extension `.ass` → `.ass.txt` để paste vào ChatGPT (ChatGPT không nhận `.ass`)
- Paste bản dịch tiếng Việt từ AI về, save thành file `vietsub.ass`
- Mở `vietsub.ass` bằng editor, chỉnh `[V4+ Styles]` cho phù hợp
- Gõ `ffmpeg -i ... -vf "subtitles=vietsub.ass" -c:v h264_qsv ...` để hardsub ra MP4

Một season 12 tập = 12 × 8 = ~100 thao tác CLI/Explorer, sai sót dễ xảy ra, không track được tập nào ở stage nào. Tôi cũng phải tự kiểm tra MKVToolNix + ffmpeg đã cài chưa trước khi dùng — chưa có cách nào tự động.

## Solution

ZimeSub là desktop app Windows (Tauri + SolidJS, UI tiếng Việt) gom toàn bộ pipeline:

- Tạo **Project** cho mỗi season, chọn 1 **ProjectFolder** để lưu artifact.
- Drag-drop MKV vào → app tự tạo **EpisodeFolder** cho mỗi tập, theo basename sanitize. **SourceMkv** giữ nguyên vị trí gốc (path-only reference, không copy/move — xem ADR-0001).
- Mỗi **Episode** có pipeline 4 stage: Extract subtitle → Extract audio (optional) → Translate (helper actions cho dán nội dung AI ngoài) → Render hardsub.
- UI hiển thị `EpisodeState` theo presence file artifact + có **Job** đang Running không.
- **JobQueue** tiered: 1 Render + N Extract chạy song song (xem ADR-0003), parse stderr ra % thật, cancel-and-cleanup.
- **Onboarding** gate ngay khi mở app nếu thiếu **RequiredTool** (`mkvmerge`/`mkvextract`/`ffmpeg`) — auto-install qua winget với log stream (xem ADR-0002).
- Render dùng **EncoderProbe** auto-detect (QSV > NVENC > AMF > libx264 fallback, xem ADR-0004), output cố định `<basename>.VietSub.mp4` MP4 + AAC.
- UI pure flat dark + accent electric green (xem `style-guide.md`).

## User Stories

### Onboarding & tool gating

1. As a new user, I want the app to auto-detect mkvmerge/mkvextract/ffmpeg on first launch (PATH + Windows default install paths), so I don't go through setup if I already have them.
2. As a new user without the required tools, I want a single-screen Onboarding that installs MKVToolNix + ffmpeg via winget, so I'm not blocked by environment setup.
3. As a user during install, I want a live monospace log stream of winget stdout/stderr, so I can see real progress and read errors.
4. As a user with outdated ffmpeg (< 4.0) or MKVToolNix (< 60), I want the app to flag the version as Outdated and prompt upgrade before allowing pipeline use, so QSV / track parsing works reliably.
5. As a user who installed tools while ZimeSub was running, I want a "Re-check tools" button in Settings that re-runs **ToolProbe**, so I don't have to restart.
6. As a user on Windows without winget (1803 hoặc enterprise restricted), I want a fallback that opens the official download page + "Tôi đã cài" button to re-probe, so I have a clear path forward.
7. As a user, I want detected tool paths cached in app settings (`%APPDATA%\ZimeSub\settings.json`), so the app doesn't re-probe on every launch.

### Project lifecycle

8. As a user, I want to create a Project by giving it a name and picking a ProjectFolder, so artifacts are organized in a place I control.
9. As a user starting a new Project, I want app to create `zimesub.json` immediately in the chosen folder, so the Project survives app restart.
10. As a user with multiple Projects, I want a left Sidebar listing recent Projects with active project highlighted (3px accent border), so I can switch quickly.
11. As a user, I want to rename a Project (folder + json updated atomically), so I can fix naming mistakes.
12. As a user, I want to delete a Project with confirm modal, so I don't accidentally lose work. Note: deleting only removes ProjectFolder content created by ZimeSub — SourceMkv files outside the folder are never touched.
13. As a user, I want a "Open in Explorer" button on ProjectFolder, so I can inspect files outside the app.

### Episode import

14. As a user, I want to drag-drop multiple MKV files onto the Project view at once and have all added as Episodes, so I'm not adding one by one.
15. As a user dragging files, I want a full-window overlay with dashed accent border appearing, so I have an unmistakable drop target.
16. As a user, I want a "Add Episodes…" button as alternative to drag-drop using native file picker (multiple selection), so I can use keyboard navigation.
17. As a user, I want each Episode's folder name to be the sanitized MKV basename (Windows-reserved chars `: < > | " \ / ? *` → `_`), so I always know which folder = which file.
18. As a user, I want the app to reject non-MKV files dropped with a clear error "Chỉ chấp nhận file .mkv", so I don't see cryptic failures later.
19. As a user, I want to remove an Episode from a Project with confirm modal, so I can clean up mistakes. Removing deletes the EpisodeFolder only — SourceMkv at original path is untouched.

### Missing source handling

20. As a user with a moved/renamed SourceMkv, I want the affected Episode marked as `MissingSource` with a red badge, so I see the problem at a glance.
21. As a user with a `MissingSource` Episode, I want Extract and Render buttons disabled with tooltip "MKV gốc không tìm thấy", so I don't click and get a cryptic ffmpeg error.
22. As a user, I want Translate-stage actions (open folder, convert to .txt, paste back, style patch) to remain enabled even when source is missing, so I can keep working on translation if .ass and .mp3 are already extracted.
23. As a user, I want a "Relocate…" button on a `MissingSource` Episode that opens file picker for a new MKV path and updates `zimesub.json`, so I can fix the path without rebuilding the Episode.

### Subtitle extract

24. As a user, I want to see a table of all subtitle tracks in a SourceMkv (columns: track id, language, codec, title, default/forced flags), so I can pick the right one.
25. As a user, I want PGS / VobSub (bitmap) rows shown disabled with badge "Bitmap — không hỗ trợ", so I know they need external OCR.
26. As a user with a typical anime MKV, I want one track pre-selected (priority: codec=ASS AND (lang=eng OR is_default) AND title not containing "sign"/"song"), so 1-click extract works.
27. As a user picking an SRT track, I want the app to auto-convert it to ASS during extract, so the rest of my workflow is uniform.
28. As a user, I want extract subtitle to write to `<basename>.eng.ass` in the EpisodeFolder, so naming is consistent and self-documenting.
29. As a user extracting, I want a progress bar showing real % parsed from mkvextract output, so I know it's working and how long left.
30. As a user re-extracting an Episode that already has ExtractedSub, I want a confirm modal "Ghi đè .ass hiện có?", so I don't lose work.

### Audio extract

31. As a user, I want to extract audio as MP3 (default libmp3lame -q:a 2) from SourceMkv to `<basename>.mp3` in EpisodeFolder, so I can listen back while QC'ing translation.
32. As a user, I want to override audio codec (mp3/aac/flac) and quality per Project default, so I can balance size vs fidelity.
33. As a user not needing audio, I want to skip this stage entirely — the Episode never becomes blocked on it (audio is optional, not gating).
34. As a user extracting audio, I want a progress bar parsed from ffmpeg stderr `time=`, so I see real ETA.

### Translate stage

35. As a user, I want a button "Mở thư mục Episode" that opens the EpisodeFolder in Windows Explorer, so I can browse files manually.
36. As a user, I want a button "Tạo file .ass.txt" that creates a `<basename>.eng.ass.txt` copy of ExtractedSub in EpisodeFolder, so I can paste content into ChatGPT/Gemini (which often reject `.ass` extension).
37. As a user, I want a "Dán bản dịch" button that opens a large textarea where I paste the full translated ASS file from AI and save as `<basename>.vietsub.ass`, so I produce TranslatedSub.
38. As a user, I want a confirm modal "Ghi đè vietsub.ass hiện có?" if `<basename>.vietsub.ass` already exists, so I don't lose previous translation.
39. As a user wanting to change style, I want a "Dán [V4+ Styles]" button that opens textarea for the styles section text, and **StylePatch** replaces exactly that section in TranslatedSub (other sections untouched), so I don't manually edit a long file.
40. As a user attempting StylePatch on an Episode without TranslatedSub, I want the button disabled with tooltip "Cần có bản dịch trước", so the flow is obvious.
41. As a user with stale Render after StylePatch, I want a "Render lỗi thời" badge appearing on the Episode, so I know to re-render.

### Render (hardsub)

42. As a user, I want the app to run **EncoderProbe** on first launch (and on Re-check) parsing `ffmpeg -encoders`, so it knows what hardware encoders are available.
43. As a user, I want auto-selected encoder using priority QSV > NVENC > AMF > libx264, so I don't pick the wrong one.
44. As a user, I want a single quality slider 0–100 in Project settings that maps to engine-specific quality params (`-global_quality`/`-cq`/`-quality`/`-crf` per ADR-0004), so I don't have to remember which flag.
45. As a user, I want Render output filename fixed as `<basename>.VietSub.mp4` in EpisodeFolder, so files copied out are self-documenting.
46. As a user, I want hardsub to spawn ffmpeg with cwd = EpisodeFolder and relative filter `subtitles=<basename>.vietsub.ass`, so Windows path quirks in `subtitles=` are avoided (ADR-0004).
47. As a user, I want audio always re-encoded to AAC during hardsub (matches user's reference example), so MP4 plays everywhere.
48. As a user rendering, I want progress bar showing real % parsed from ffmpeg stderr `frame=`/`time=`, plus current frame/total frames + ETA in the status bar.
49. As a user, I want **RenderConfig** stored 2-layer: project-level default in `zimesub.json` + per-Episode override (optional), so I can fine-tune one tập without affecting the project default.
50. As a user trying to Render an Episode without TranslatedSub, I want the button disabled with tooltip "Cần TranslatedSub trước", so the flow is obvious.
51. As a user, I want a Render to a machine without the configured encoder (e.g. project shared from QSV machine, opened on AMD-only machine) to auto-fallback to the highest available encoder with a one-time warning, so the render doesn't fail silently.

### Job queue & background execution

52. As a user, I want every pipeline action (extract sub, extract audio, render) to enqueue a **Job** instead of blocking the UI, so I can navigate while work happens.
53. As a user, I want a bottom status bar always visible showing `JobQueue` summary (running count / queue length) + current Job's progress + cancel button, so I have ambient awareness from any view.
54. As a user, I want to expand the status bar to a full Jobs panel listing pending/running/done/failed Jobs (with timestamps and Episode references), so I can see history.
55. As a user, I want the tiered concurrency rule enforced (max 1 Render Running + max N Extract Running, N default 2 configurable in Settings), so my GPU isn't overloaded while light tasks proceed.
56. As a user, I want to cancel a Running Job — process tree killed + partial output files deleted (e.g. dangling `<basename>.VietSub.mp4` if Render cancelled, `<basename>.eng.ass` if ExtractSubtitle cancelled), so I'm never left with half files.
57. As a user, I want to remove a Pending Job from queue (no process to kill, just pop), so I can change my mind before it starts.
58. As a user whose app crashed mid-Job, I want next launch to detect Job rows in `zimesub.json` (if persisted) or simply ignore in-memory queue (acceptable for v1), and clean up partial files in EpisodeFolders, so I don't ship corrupt artifacts.

### UI shell & language

59. As a user, I want the UI to be in Vietnamese (no i18n framework needed in v1), so I read in my native language.
60. As a user working late, I want pure flat dark UI — no shadow, no gradient, no blur — with electric green accent and Geist Sans/Mono typography, so it's stylish and easy on the eyes (per `style-guide.md`).
61. As a user, I want thick borders (2–3 px) replacing shadow as the section separator language, so the flat aesthetic is consistent.
62. As a user, I want primary buttons large (≥ 44×44 px hit target, padding 12×20), so I'm precise on dense UIs.
63. As a user reading the winget log stream and ffmpeg progress, I want a monospace font (Geist Mono) and terminal-like styling, so multi-line tool output is readable.
64. As a user, I want common keyboard shortcuts (Ctrl+N new project, Ctrl+, settings, Esc close modal, J/K navigate Episode list), so I'm faster than mouse-only.

### Settings & persistence

65. As a user, I want app-level settings (tool paths, recent projects, default extract/render configs, queue concurrency N, UI language) stored in `%APPDATA%\ZimeSub\settings.json`, so they persist across launches and Projects.
66. As a user opening the app, I want it to open the most recently active Project automatically (or Onboarding if tools missing), so I'm productive immediately.
67. As a user, I want app-level logs written to `%APPDATA%\ZimeSub\logs\zimesub.log` (rotated 5 × 2 MB), so when bugs happen I can attach a log when reporting.

## Implementation Decisions

### Module breakdown (deep-first)

The Rust backend is structured so that all parsing, scheduling, and state-derivation logic lives in pure or near-pure modules. The Tauri command layer is intentionally thin glue.

- **`tooling`** — Detect, install, version-check **RequiredTool**. Interface: `detect(name) -> Result<Tool>`, `install(name) -> impl Stream<LogLine>`, `version(path) -> SemVer`. Encapsulates PATH lookup (via `which`), Windows default paths, `winget` invocation, per-tool version regex.
- **`project_store`** — Single source of truth for `zimesub.json`. Interface: `open(path) -> Project`, `add_episode(source_mkv_path) -> EpisodeId`, `remove_episode(id)`, `relocate(id, new_path)`, `set_selected_track(id, mkv_track_id)`, `set_render_config_override(id, cfg)`. Owns EpisodeFolder creation + Windows name sanitization.
- **`mkv_probe`** *(pure)* — `parse_mkvmerge_json(stdout: &str) -> Vec<SubtitleTrack>`. Maps `mkvmerge -i -F json` output into typed tracks with `extractable: bool` flag (true for ASS/SRT, false for PGS/VobSub).
- **`encoder_probe`** *(pure)* — `parse_ffmpeg_encoders(stdout: &str) -> Vec<Encoder>` sorted by priority (QSV > NVENC > AMF > libx264). Knows quality flag per engine.
- **`progress_parsers`** *(pure)* — `parse_ffmpeg(line: &str) -> Option<ProgressUpdate>` (matches `frame= time= speed=`), `parse_mkvextract(line: &str) -> Option<ProgressUpdate>` (matches `Progress: N%`). `ProgressUpdate = { ratio: f32, hint: String }`.
- **`ass_ops`** *(pure-ish)* — `make_draft(ass_path) -> draft_path` (read + copy with `.ass.txt` extension), `replace_styles_section(target_ass_path, styles_block: &str) -> Result<()>` (parse sections, replace `[V4+ Styles]`, keep others intact), `write_translated(target_path, full_ass: &str) -> Result<()>`.
- **`job_queue`** — Tiered scheduler. Interface: `enqueue(spec: JobSpec) -> JobId`, `cancel(id)`, `remove_pending(id)`, `snapshot() -> JobsSnapshot`, `subscribe() -> Receiver<JobEvent>`. Enforces 1 Render + N Extract concurrency. Per-`JobKind` cleanup-on-cancel.
- **`process_runner`** — Subprocess + stderr streaming, used by extract and render alike. Interface: `run(spec: RunSpec) -> impl Stream<RunEvent>` where `RunSpec = { executable, args, cwd, progress_parser }` and `RunEvent = Log(line) | Progress(ratio) | Done(ExitStatus)`.
- **`settings_store`** — `%APPDATA%\ZimeSub\settings.json` read/write.
- **`tauri_commands`** — Thin glue, no logic.

### Frontend module breakdown (SolidJS)

- `api/` — TS bindings to Tauri commands (one file per Rust module's surface).
- `stores/projects`, `stores/jobs`, `stores/tools`, `stores/settings` — SolidJS stores subscribed to Tauri events.
- `design-system/` — Geist self-hosted, color tokens, Lucide icons, primitive components (Button, Card with thick border, TerminalLog, ProgressBar).
- `views/onboarding` — Tool gate UI, winget log stream panel.
- `views/project` — Sidebar + Episode list + per-Episode pipeline panel.
- `views/track-picker` — Modal table of SubtitleTrack with PGS/VobSub disabled rows.
- `views/translate-panel` — Open folder / Convert to .txt / Paste translation / StylePatch buttons + textareas.
- `views/render-config` — Project default + per-Episode override forms.
- `views/jobs-panel` — Bottom expandable Jobs list.
- `components/drop-overlay` — Full-window drag overlay with accent dashed border.

### Schemas

`zimesub.json`:

```jsonc
{
  "version": 1,
  "name": "Oi Tonbo 2nd Season",
  "created_at": "2026-06-08T15:00:00+07:00",
  "default_render_config": {
    "encoder": "auto",     // "auto" | "h264_qsv" | "h264_nvenc" | "h264_amf" | "libx264"
    "quality": 65,          // 0-100 slider, maps per-engine
    "audio_codec": "aac",
    "audio_bitrate_kbps": 192
  },
  "default_extract_audio": {
    "codec": "libmp3lame",
    "quality_or_bitrate": "q:a 2"
  },
  "episodes": [
    {
      "id": "uuid-v4",
      "source_mkv_path": "C:\\Users\\me\\Anime\\[Erai-raws] Oi Tonbo - 01 [1080p][HEVC][1E1E044E].mkv",
      "folder_name": "[Erai-raws] Oi Tonbo - 01 [1080p][HEVC][1E1E044E]",
      "selected_subtitle_track_id": 2,
      "render_config_override": null
    }
  ]
}
```

`%APPDATA%\ZimeSub\settings.json`:

```jsonc
{
  "version": 1,
  "tool_paths": {
    "mkvmerge":   "C:\\Program Files\\MKVToolNix\\mkvmerge.exe",
    "mkvextract": "C:\\Program Files\\MKVToolNix\\mkvextract.exe",
    "ffmpeg":     "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_...\\ffmpeg.exe"
  },
  "tool_versions": { "mkvmerge": "84.0", "ffmpeg": "6.1" },
  "available_encoders": ["h264_qsv", "h264_nvenc", "libx264"],
  "recent_projects": ["C:\\Users\\me\\Docs\\OiTonboS2", "..."],
  "queue_concurrency_extract": 2,
  "ui": { "language": "vi" }
}
```

### Derivation: EpisodeState (pure function over disk + queue snapshot)

```
function derive_state(episode, episode_folder, jobs_snapshot) -> EpisodeState:
  if source_mkv_path does not exist on disk:
    return MissingSource(overlay)

  running_job = jobs_snapshot.first_running_for(episode.id)
  if running_job:
    match running_job.kind:
      Render            -> Rendering
      ExtractSubtitle|
      ExtractAudio      -> Extracting

  has_render     = (folder / "<basename>.VietSub.mp4").exists()
  has_translated = (folder / "<basename>.vietsub.ass").exists()
  has_draft      = (folder / "<basename>.eng.ass.txt").exists()
  has_extracted  = (folder / "<basename>.eng.ass").exists()

  if has_render and not is_render_stale:    return Rendered
  if has_translated:                         return Translated
  if has_draft and not has_translated:       return Translating
  if has_extracted:                          return Extracted
  return Empty
```

Render staleness is determined by mtime comparison: Render mtime < TranslatedSub mtime.

### Tauri capabilities

In `src-tauri/capabilities/default.json`, add (preserve existing):

- `core:dialog` — file/folder picker
- `core:fs:default` + scoped fs write to project folders chosen at runtime (dynamic scope expansion)
- `core:shell:execute` — explicitly scoped to executables in `settings.tool_paths` (resolved at runtime; the capability schema permits absolute paths via scope after detection)
- `core:opener:default` — open Explorer for a folder path
- Drag-drop: enable `dragDropEnabled: true` in window config

### Rust dependencies to add to `src-tauri/Cargo.toml`

- `tokio` with `process` + `io-util` + `macros` + `sync` features (subprocess streaming + channels)
- `uuid` with `v4`, `serde` features
- `regex` (progress parsing)
- `which` (PATH detection for tools)
- `tauri-plugin-fs` 2.x
- `tauri-plugin-shell` 2.x
- `tauri-plugin-dialog` 2.x
- `tauri-plugin-opener` 2.x
- `dirs` (resolve `%APPDATA%`)
- `chrono` for ISO timestamps in settings/log

### Frontend dependencies to add to `package.json`

- `@tauri-apps/plugin-fs`
- `@tauri-apps/plugin-shell`
- `@tauri-apps/plugin-dialog`
- `@tauri-apps/plugin-opener`
- `geist` (self-host woff2 fonts)
- `lucide-solid`
- (No router needed in v1 — single window, route state in stores.)

### Tauri config tweaks

`src-tauri/tauri.conf.json`:

- `productName` → `ZimeSub`
- `identifier` → `dev.phuvinhai.zimesub`
- Window: `title: "ZimeSub"`, `width: 1280`, `height: 800`, `minWidth: 1024`, `minHeight: 720`, `dragDropEnabled: true`, `decorations: true` (default chrome OK for v1)

`package.json`: rename `name` → `zimesub`, `version` → `0.1.0`, `author` → `PhuVinhAI`.

`src-tauri/Cargo.toml`: rename `name` → `zimesub`, `description` → `Pipeline làm phụ đề tiếng Việt cho anime`.

### Process spawn rules

- Always spawn with explicit `cwd` = EpisodeFolder for Render Jobs (avoids subtitles= filter Windows path quirks per ADR-0004).
- Never pass user-controllable strings into shell — always argv form.
- stderr is parsed line-by-line; raw lines also pushed to a per-Job log buffer for the Jobs panel detail view.
- On cancel, send SIGKILL (Windows: `TerminateProcess` via tokio's `Child::kill`) and walk EpisodeFolder for files matching the JobKind's "partial output" list.

## Testing Decisions

**No automated tests for v1.** Ship by hand.

The architecture is deliberately shaped to make tests cheap to add later without rewriting modules:

- `mkv_probe`, `encoder_probe`, `progress_parsers`, `ass_ops` are pure functions taking strings/text → typed output. Future tests are fixture-driven (a few captured `mkvmerge -i -F json` outputs, a few `ffmpeg -encoders` snapshots, a few stderr line samples, a few ASS fixtures with known `[V4+ Styles]` blocks).
- The `derive_state` function is pure over disk presence + job snapshot. Future tests use a tempdir + faked JobsSnapshot.
- `tooling` and `project_store` are deep but I/O-bound; future tests use tempdir + a fake `which` resolver / fake subprocess.
- `job_queue` is testable with a fake `JobRunner` injected — its concurrency rules and cleanup logic are pure state-machine behavior.

When tests are written, prior art reference: standard Rust `#[cfg(test)] mod tests` blocks per module. No mocking framework — hand-rolled fakes.

## Out of Scope

- AI translation logic. ZimeSub does not call any AI API; the user pastes content into ChatGPT/Gemini externally and pastes results back.
- OCR for bitmap subs (PGS/VobSub). Shown disabled in UI per Q4.
- Multi-track extract per Episode — only 1 primary track in v1 per Q3.
- Non-MKV source video formats (MP4 source, AVI, etc.) — MKV-only in v1.
- macOS / Linux builds — Windows-only in v1 (winget gating, fixed install paths, QSV reliance).
- Subtitle timing/syntax editor — user uses Aegisub/Subtitle Edit externally.
- Built-in video player / preview of rendered subs — user opens output MP4 in their player.
- Import-external-sub (paste an .ass that didn't come from this MKV) — out of scope per Q4b.
- Multi-language UI / i18n framework — Vietnamese only in v1.
- Cloud sync / multi-machine Project sharing.
- Auto-update for the app itself.
- Bulk-render-all-Episodes — v1 enqueues per Episode only per Q8e.
- Trash/undo for deleted Episodes/Projects.

## Further Notes

- All UI strings in Vietnamese; code identifiers, log messages, ADRs, and PR descriptions in English.
- Glossary in `CONTEXT.md` is canonical — code modules and Tauri command names must use the chosen terms (`Project`, `Episode`, `SourceMkv`, `ExtractedSub`, `TranslationDraft`, `TranslatedSub`, `StylePatch`, `ExtractedAudio`, `Render`, `RenderConfig`, `Job`, `JobQueue`, `Onboarding`, `RequiredTool`, `ToolProbe`, `EncoderProbe`, `EpisodeState`, `MissingSource`, `Relocate`).
- The `winget install` flow may invoke UAC; ZimeSub itself does NOT request elevation. winget's per-install elevation prompts are intentional and surfaced as part of the user's expected install experience.
- v1 ships as Windows NSIS + MSI bundles only.
- Forbidden Tailwind classes (lint these): any `shadow-*`, `bg-gradient-*`, `backdrop-blur-*`, `drop-shadow-*`. Enforces pure flat aesthetic from `style-guide.md`.
- Issue breakdown into vertical-slice tickets is a separate next step (`/to-issues`), tickets land in `.scratch/zimesub-v1/issues/`.
