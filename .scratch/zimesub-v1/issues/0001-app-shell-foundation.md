---
title: "App shell foundation: branding, design system, layout"
labels: [ready-for-agent]
type: AFK
blocked_by: []
user_stories: [60, 61, 62, 63, 64, 10]
---

# 0001 — App shell foundation: branding, design system, layout

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## What to build

Rebrand the Tauri starter template as ZimeSub and stand up the empty UI shell that all subsequent slices plug into. After this slice, launching the app shows a branded dark window with the layout chrome (Sidebar / Main / Bottom status bar) per [`docs/style-guide.md`](../../../docs/style-guide.md), but no functional features yet.

## Acceptance criteria

- [ ] Tauri `productName`, `identifier`, window title, package.json `name`, and Cargo `name` are renamed to `ZimeSub` / `dev.phuvinhai.zimesub` / `zimesub`.
- [ ] Window opens at 1280×800 with minimum 1024×720. `dragDropEnabled: true` at the Tauri config level.
- [ ] Tailwind palette tokens from `style-guide.md` are wired via CSS variables (bg, surface, border, border-strong, text, text-muted, accent `#00FF66`, accent-on-accent, danger, warn). Dark-only.
- [ ] Geist Sans and Geist Mono are self-hosted (woff2). Sans is the default body font; Mono is on a `.font-mono` utility for later log streams and file paths.
- [ ] Lucide icon set wired with stroke `1.5` px, no fill.
- [ ] Layout shell renders: fixed 280 px left Sidebar (top label "ZIMESUB", empty "PROJECTS" section, bottom "＋ Tạo project" CTA), Main content area with empty state "Chưa có project nào", Bottom status bar 56 px showing placeholder "JOBS — chưa có job nào".
- [ ] A lint or codemod rejects any `shadow-*`, `bg-gradient-*`, `backdrop-blur-*`, `drop-shadow-*` utility in source files. CI/dev script fails on violation.
- [ ] A global keyboard shortcut router scaffold exists (a single composable hook + central registry). `Esc` closes any open modal once modals exist in later slices.
- [ ] UI strings throughout the shell are Vietnamese.
- [ ] Previous starter components (Header, Main, Footer, Link) are removed.

## Blocked by

None — can start immediately.
