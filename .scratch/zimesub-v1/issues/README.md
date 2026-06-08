# Issues — ZimeSub v1

Folder này chứa các issue được break ra từ [`../prd.md`](../prd.md) theo tracer-bullet vertical slice convention.

Chạy `/to-issues` (skill) trong chat để generate.

Naming: `NNNN-slug.md` (NNNN sequential, slug kebab-case theo title).

Labels (gắn ở header front-matter của mỗi file):

- `ready-for-agent` — PRD đã chốt, AFK agent có thể pick.
- `hitl` — slice cần human-in-the-loop (architectural decision, design review).
- `blocked` — đang chờ slice khác.
