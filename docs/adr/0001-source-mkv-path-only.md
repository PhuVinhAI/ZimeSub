# Source MKV is referenced by path, not owned by the project

Anime MKV files are 1–3 GB. Copying or moving them into the project folder is expensive (disk space, time) and risky (move breaks torrent seeding, Plex/Jellyfin indexes, MPV playlists, and can half-fail on cross-volume moves). Symlinks need Developer Mode on Windows; hardlinks only work on the same volume.

We decided that a **Project** stores only the **absolute path** to each **SourceMkv** and never owns the file. The project folder contains only derived artifacts (extracted subtitles, extracted audio, translated subtitle, rendered MP4). If the source disappears, the Episode enters **MissingSource** state — translate/edit still work on already-extracted artifacts, but re-extract and hardsub are blocked until the user **Relocate**s.

## Consequences

- Extracted artifacts (`.ass`, `.mp3`, rendered `.mp4`) live in the project folder and are portable; the source video is not.
- The app must detect missing sources on project open and on each pipeline action, and surface a clear Relocate UX.
- Deleting a project never deletes user-owned MKV files.
