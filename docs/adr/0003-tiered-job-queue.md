# Tiered job queue: 1 hardsub + N extract concurrent

ZimeSub runs three kinds of background work: subtitle extract (mkvextract, light), audio extract (ffmpeg → mp3, medium), and hardsub render (ffmpeg with subtitles filter + QSV encode, heavy). Running everything serial wastes capacity; running everything in parallel saturates disk/CPU and starves the heavy hardsub.

We decided a **tiered scheduler**: at most **1 Render job** runs at any time, but extract jobs (`ExtractSubtitle`, `ExtractAudio`) may run in parallel with the active Render and with each other (default: up to 2 extract jobs concurrently, user-configurable). All work flows through a single **JobQueue** with status `Pending | Running | Done | Failed | Cancelled`; progress is parsed from ffmpeg/mkvextract stderr for a real percentage. Cancel kills the process tree and deletes partial output files.

## Consequences

- Frontend must surface a "Jobs" panel showing the queue regardless of which Project the user is currently viewing.
- Per-Episode buttons enqueue a single job; there is no bulk "render all" trigger in v1 (can be added later by enqueueing N jobs).
- Cleanup-on-cancel logic must be per-JobKind (e.g. delete `vietsub.mp4` if a Render is cancelled, delete `eng.ass` if ExtractSubtitle is cancelled).
