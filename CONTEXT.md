# ZimeSub

Desktop app (Tauri + SolidJS) hỗ trợ pipeline làm phụ đề tiếng Việt cho anime: nhập video MKV → trích xuất subtitle/audio → dịch bằng AI ngoài → hardsub ra MP4.

## Language

**Project**:
Đơn vị chứa toàn bộ pipeline cho một bộ anime (thường là 1 season, ví dụ "Oi Tonbo 2nd Season"). Trên disk là 1 folder do user chỉ định, trong UI hiện như một "workspace".
_Avoid_: Workspace (chỉ là từ UI), Series (gò bó nếu sau muốn gộp nhiều season), Folder.

**Episode**:
Một video MKV thuộc một **Project**. Là đơn vị mà các bước của pipeline (extract sub, extract audio, translate, hardsub) chạy trên đó.
_Avoid_: Video (mơ hồ giữa source và rendered), File, Tập (mix tiếng Việt vào identifier).

**SourceMkv**:
File MKV gốc của một **Episode**, nằm ở vị trí gốc trên disk của user (ngoài project folder). **Project** chỉ giữ đường dẫn tuyệt đối tới file này, không sở hữu/move/copy. Xem ADR-0001.
_Avoid_: Source file, Original video, Input.

**MissingSource**:
Trạng thái của một **Episode** khi `SourceMkv` không còn tồn tại ở đường dẫn đã lưu (user đã move/rename/xoá). Episode vẫn dùng được cho các bước không cần video gốc (translate, edit sub), nhưng chặn re-extract và hardsub cho tới khi user **Relocate**.
_Avoid_: Broken link, Missing file, Orphan.

**Relocate**:
Hành động user cập nhật lại đường dẫn `SourceMkv` cho một Episode đang ở trạng thái **MissingSource**.
_Avoid_: Re-link, Fix path, Update source.

## Subtitle pipeline

**SubtitleTrack**:
Một subtitle track embedded trong **SourceMkv**, chưa extract. Có metadata `{mkv_track_id, language, codec, title, is_default, is_forced}`. Một SourceMkv chứa 0..N SubtitleTrack. Codec chỉ có thể là `ass` hoặc `srt` thì mới extract được; `pgs`/`vobsub` (bitmap) hiển thị trong UI nhưng disabled.
_Avoid_: Sub track, Embedded sub, Track.

**ExtractedSub**:
File subtitle gốc (ngôn ngữ nguồn, thường là English) đã extract ra disk từ một SubtitleTrack đã chọn. Luôn là `.ass` trên disk — nếu track gốc là SRT thì app auto-convert sang ASS khi extract. Mỗi Episode có 0..1 ExtractedSub.
_Avoid_: Source sub, English sub, Origin sub.

**TranslationDraft**:
File `.ass.txt` — bản copy y nguyên của `ExtractedSub` chỉ đổi extension, nằm cạnh ExtractedSub trong folder Episode. Mục đích duy nhất: dễ paste vào ChatGPT/Gemini (các AI chat không nhận extension `.ass`). App không track nội dung của file này sau khi tạo — nó là **disposable artifact**, có thể regenerate bất kỳ lúc nào từ ExtractedSub.
_Avoid_: Translation source, AI input, Draft.

**TranslatedSub**:
File `<basename>.vietsub.ass` — bản tiếng Việt mà user paste về sau khi dịch bằng AI ngoài. Nằm trong EpisodeFolder (xem naming convention ở EpisodeFolder). Format luôn là full ASS file (không phải dialogue-only). Nguồn của bước hardsub.
_Avoid_: Vietnamese sub, Final sub, VietSub (case-sensitive).

**StylePatch**:
Hành động (không phải file) user paste một section `[V4+ Styles]` (text bắt đầu từ dòng `[V4+ Styles]` đến hết section đó) → app replace đúng section trong `TranslatedSub`. Yêu cầu `TranslatedSub` đã tồn tại; không tự sinh file mới.
_Avoid_: Style edit, Style override, Theme.

## Audio pipeline

**ExtractedAudio**:
File `.mp3` extract từ `SourceMkv` bằng ffmpeg (mặc định libmp3lame, có UI tuỳ chỉnh codec/bitrate). Optional — user có thể skip bước này. Mỗi Episode có 0..1 ExtractedAudio. Mục đích: nghe lại cho khâu QC/dịch, không tham gia hardsub.
_Avoid_: Audio file, MP3, Audio track.

## Render pipeline

**Render**:
File MP4 final đã hardsub `TranslatedSub` vào `SourceMkv` bằng ffmpeg. Tên cố định `<MKV_basename>.VietSub.mp4` trong EpisodeFolder. Mỗi Episode có 0..1 Render (re-render ghi đè).
_Avoid_: Output, Final video, VietSub video, MP4.

**RenderConfig**:
Cấu hình cho một Render job: `{encoder, quality, audio_codec, audio_bitrate}`. Lưu ở 2 layer: project-level default trong `zimesub.json`, per-Episode override (optional) trong cùng file. Xem ADR-0004.
_Avoid_: Render settings, Encode preset, Profile.

**EncoderProbe**:
Hành động chạy `ffmpeg -hide_banner -encoders` để xác định encoder khả dụng trên máy. Kết quả cache vào app settings; danh sách `available_encoders: Vec<Encoder>` sorted theo priority QSV > NVENC > AMF > libx264. Re-run khi user click "Re-check tools".
_Avoid_: Encoder detect, GPU check.

## Example dialogue

> **Dev**: User vừa tạo Project "Oi Tonbo S2" và drag 3 file MKV vào. Cần làm gì?
>
> **Domain**: 3 Episode được tạo, mỗi cái EpisodeState = `Empty`. Project chỉ giữ absolute path tới mỗi **SourceMkv** — không move, không copy. Mỗi Episode có 1 EpisodeFolder mới với tên = sanitize(basename của SourceMkv).
>
> **Dev**: User click "Extract sub" trên Episode 1. App làm gì?
>
> **Domain**: Tạo 1 Job kind=`ExtractSubtitle` cho Episode đó. JobQueue đang rảnh thì Run ngay. App chạy `mkvmerge -i` để list **SubtitleTrack**, hiển thị bảng UI; user chọn 1 track ASS hoặc SRT (PGS disabled). Click confirm → app chạy `mkvextract tracks` ghi `<basename>.eng.ass` vào EpisodeFolder. Done → có **ExtractedSub**.
>
> **Dev**: User chuyển sang Episode 2 và click "Render" trong khi Episode 1 Extract còn chạy. Có cho không?
>
> **Domain**: Cho. Tiered queue: 1 Render + N Extract chạy song song được. Job `Render` enqueue và Run ngay vì chưa có Render nào Running. Nhưng — chặn nếu Episode 2 chưa có TranslatedSub: state phải ≥ `Translated`.
>
> **Dev**: Render xong rồi user đổi style. Phải re-render không?
>
> **Domain**: Có. **StylePatch** chỉ thao tác trên TranslatedSub — Render là file MP4 đã bake style cũ vào. EpisodeState quay về `Translated` (file Render cũ vẫn còn, badge "outdated" hiện trên UI).
>
> **Dev**: User mở app, MKV gốc của Episode 3 không còn trên disk (user đã move sang ổ khác).
>
> **Domain**: Episode 3 vào trạng thái **MissingSource** (overlay). Nút Extract và Render bị disable + badge đỏ. User click **Relocate** → file picker → cập nhật path. Translate vẫn dùng được (vì TranslationDraft và ExtractedSub đã có trong EpisodeFolder, không phụ thuộc SourceMkv).

## Storage layout

**ProjectFolder**:
Folder trên disk do user chỉ định khi tạo Project. Chứa đúng 1 file `zimesub.json` (metadata) + N **EpisodeFolder**. Không chứa file nào khác do app tạo ở root.
_Avoid_: Workspace folder, Project root, Data folder.

**EpisodeFolder**:
Folder con trong **ProjectFolder**, tên = sanitize(MKV base name của SourceMkv) (replace ký tự cấm Windows `: < > | " \ / ? *` thành `_`). Chứa toàn bộ artifact của 1 Episode. Naming convention bên trong (cố định, không config được):
- `<basename>.eng.ass` — ExtractedSub
- `<basename>.eng.ass.txt` — TranslationDraft
- `<basename>.vietsub.ass` — TranslatedSub
- `<basename>.mp3` — ExtractedAudio
- `<basename>.VietSub.mp4` — Render

Trong đó `<basename>` = tên folder (giữ full để file copy ra ngoài vẫn tự document).
_Avoid_: Episode dir, Ep folder.

**EpisodeState**:
Derived state (không persist riêng, suy ra từ presence của file artifact + đang có Job nào Running cho Episode đó không). Driver UI hiển thị: nút nào enable/disable, badge nào hiện. Các state điểm danh:
- `Empty` — chỉ vừa add, chưa làm gì
- `Extracting` — đang chạy ExtractSubtitle hoặc ExtractAudio
- `Extracted` — có ExtractedSub (audio optional)
- `Translating` — đang ở translate stage (presence của TranslationDraft + chưa có TranslatedSub)
- `Translated` — có TranslatedSub
- `Rendering` — đang chạy Render job
- `Rendered` — có file Render
- `MissingSource` — orthogonal state, có thể overlay lên các state trên (xem term riêng)
_Avoid_: Phase, Status, Stage state.

**zimesub.json**:
File metadata duy nhất của Project. Lưu: project name, danh sách Episode (mỗi Episode có: id, source_mkv_path tuyệt đối, episode_folder_name, selected_subtitle_track_id, pipeline state per stage). Là single source of truth — nếu file mất, app không tự rebuild từ folder structure được (vì mất mapping tới SourceMkv path).
_Avoid_: project.json, manifest, db file.

## Tool gating

**RequiredTool**:
Một trong 3 external CLI ZimeSub phụ thuộc: `mkvmerge`, `mkvextract`, `ffmpeg`. Mỗi RequiredTool có {name, absolute_path, version, minimum_version, status: Missing | Outdated | Ready}. App không ship binary nào, chỉ orchestrate (xem ADR-0002).
_Avoid_: External dep, Binary, CLI tool.

**Onboarding**:
Trạng thái mặc định khi app mở mà có ít nhất 1 RequiredTool ở status Missing hoặc Outdated. Trong Onboarding, toàn bộ UI khác bị gate — user chỉ thấy view hướng dẫn install + log stream của winget. Thoát Onboarding khi cả 3 RequiredTool đạt Ready.
_Avoid_: Setup, First-run, Welcome.

**ToolProbe**:
Hành động detect/re-detect RequiredTool: thử PATH → fallback default path → cache absolute_path đã tìm thấy vào app settings. Chạy automatic khi app start, và manually qua nút "Re-check tools" trong settings.
_Avoid_: Tool check, Detection, Scan.

## Job execution

**Job**:
Một unit of background work gắn với 1 Episode. `JobKind` ∈ {`ExtractSubtitle`, `ExtractAudio`, `Render`}. Có `JobStatus` ∈ {`Pending`, `Running`, `Done`, `Failed`, `Cancelled`} và `progress: 0.0..1.0` parse từ stderr của tool.
_Avoid_: Task, Operation, Process.

**JobQueue**:
Scheduler global của app (không per-project). Áp dụng quy tắc tiered: tối đa 1 `Render` Running cùng lúc + tối đa N `ExtractSubtitle`/`ExtractAudio` Running cùng lúc (N default 2, configurable). Xem ADR-0003.
_Avoid_: Task queue, Pipeline, Scheduler.

**JobCancel**:
Hành động kill process tree của Job đang Running + xoá partial output (xoá `vietsub.mp4` nếu Render bị cancel; xoá `eng.ass` nếu ExtractSubtitle bị cancel). Khác hẳn với việc remove một Pending Job (chỉ pop khỏi queue, không kill gì).
_Avoid_: Stop, Abort, Kill.
