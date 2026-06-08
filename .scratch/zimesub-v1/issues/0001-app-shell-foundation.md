---
title: "App shell foundation: branding, design system, layout"
labels: [done]
type: AFK
blocked_by: []
user_stories: [60, 61, 62, 63, 64, 10]
status: done
---

# 0001 — App shell foundation: branding, design system, layout

## Parent
PRD: [`.scratch/zimesub-v1/prd.md`](../prd.md)

## Status

**Done.** Lint (`bun run lint`), forbidden-class check (`bun run lint:classes`), and TypeScript (`bun run typecheck`) all pass clean. Verified end-to-end on 2026-06-08.

## What to build

Rebrand the Tauri starter template as ZimeSub and stand up the empty UI shell that all subsequent slices plug into. After this slice, launching the app shows a branded dark window with the layout chrome (Sidebar / Main / Bottom status bar) per [`docs/style-guide.md`](../../../docs/style-guide.md), but no functional features yet.

## Acceptance criteria

- [x] Tauri `productName`, `identifier`, window title, package.json `name`, and Cargo `name` are renamed to `ZimeSub` / `dev.phuvinhai.zimesub` / `zimesub`.
- [x] Window opens at 1280×800 with minimum 1024×720. `dragDropEnabled: true` at the Tauri config level.
- [x] Tailwind palette tokens from `style-guide.md` are wired via CSS variables (bg, surface, border, border-strong, text, text-muted, accent `#00FF66`, accent-on-accent, danger, warn). Dark-only.
- [x] Geist Sans and Geist Mono are self-hosted (woff2). Sans is the default body font; Mono is on a `.font-mono` utility for later log streams and file paths.
- [x] Lucide icon set wired with stroke `1.5` px, no fill.
- [x] Layout shell renders: fixed 280 px left Sidebar (top label "ZIMESUB", empty "PROJECTS" section, bottom "＋ Tạo project" CTA), Main content area with empty state "Chưa có project nào", Bottom status bar 56 px showing placeholder "JOBS — chưa có job nào".
- [x] A lint or codemod rejects any `shadow-*`, `bg-gradient-*`, `backdrop-blur-*`, `drop-shadow-*` utility in source files. CI/dev script fails on violation.
- [x] A global keyboard shortcut router scaffold exists (a single composable hook + central registry). `Esc` closes any open modal once modals exist in later slices.
- [x] UI strings throughout the shell are Vietnamese.
- [x] Previous starter components (Header, Main, Footer, Link) are removed.

## Blocked by

None — can start immediately.

## Implementation notes

Built on top of the existing Tauri 2 + SolidJS + Vite + Tailwind v4 + TypeScript scaffold. No router (PRD calls for single-window state via stores in later slices). Tailwind tokens use the v4 `@theme` CSS-first config; the legacy `tailwind.config.ts` is left in place for backward compat but no longer drives palette/font tokens.

Design-token names match `docs/style-guide.md` exactly: `bg`, `surface`, `border`, `border-strong`, `text`, `text-muted`, `accent`, `accent-on-accent`, `danger`, `warn`. Fonts are pulled from `@fontsource-variable/geist` / `@fontsource-variable/geist-mono` (woff2 with a Vietnamese unicode-range subset baked in), giving `font-sans` → `Geist Variable` and `font-mono` → `Geist Mono Variable`.

The forbidden-utility check (`scripts/lint-forbidden-classes.mjs`) masks comment bodies before scanning so that documentation strings referencing the forbidden patterns (e.g. JSDoc and CSS comments) don't trigger false positives. It is wired into `package.json` as `lint:classes` and runs as the first step of `bun run lint`.

The keyboard registry is intentionally minimal: a module-level `Map<symbol, ShortcutBinding>` plus a lazily-attached `keydown` listener on `window`. Components compose via `useKeyboardShortcut(combo, handler)`, which cleans up on owner dispose. The matching `modalStack` exposes `useModal(closeFn)` so future modal components can register, and `installGlobalShortcuts()` (called once from `AppShell.onMount`) binds `Escape` to `closeTopModal`. No modals exist yet, so Escape is a no-op until later slices.

`tsconfig.json` was modernised away from the deprecated `moduleResolution: node` + `baseUrl` combo to `moduleResolution: Bundler` + path-only aliases, eliminating the TS 7.0 deprecation warnings that began surfacing on TS 6.0.

### Files created

| File | Purpose |
|---|---|
| `scripts/lint-forbidden-classes.mjs` | Codemod-style lint that fails when any `shadow-*` / `bg-gradient-*` / `backdrop-blur-*` / `drop-shadow-*` utility appears in `src/` or `index.html`. Masks comments to avoid documentation-string false positives. |
| `src/components/shell/AppShell.tsx` | Root three-region layout (Sidebar / Main / StatusBar). Boots global keyboard shortcuts on mount. |
| `src/components/shell/Sidebar.tsx` | 280 px left sidebar — ZIMESUB wordmark, empty PROJECTS section, "Tạo project" CTA with `lucide-solid` `Plus` icon (disabled until slice 0004). |
| `src/components/shell/StatusBar.tsx` | 56 px bottom status bar — placeholder "JOBS — chưa có job nào". Hooked up to live `JobQueue` in slice 0008. |
| `src/components/shell/EmptyProjectsState.tsx` | Centered "Chưa có project nào" empty state for Main while no project is active. Replaced by Project view in slice 0004. |
| `src/lib/keyboard/shortcut-registry.ts` | Pure registry: parses combo strings (`Ctrl+N`, `Escape`, …), attaches a single `window` keydown listener lazily, supports listing/unregistering. |
| `src/lib/keyboard/useKeyboardShortcut.ts` | Solid composable wrapping `registerShortcut` with `onCleanup` lifecycle. |
| `src/lib/keyboard/globalShortcuts.ts` | One-shot installer called from `AppShell.onMount`; wires `Escape` → close top modal. Where future global shortcuts (Ctrl+N, Ctrl+, etc.) will be added. |
| `src/lib/modal/modalStack.ts` | Solid-signal-backed modal stack with `useModal(closeFn)`, `pushModal`, `popModal`, `closeTopModal`, `hasOpenModal`. Lets a single Escape binding pop whichever modal is on top. |

### Files modified

| File | Change |
|---|---|
| `package.json` | Renamed to `zimesub` 0.1.0, author `PhuVinhAI`, description set. Added `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`, `lucide-solid` deps. Added `lint:classes`, `lint`, `typecheck` scripts. |
| `src-tauri/tauri.conf.json` | `productName` → `ZimeSub`, `identifier` → `dev.phuvinhai.zimesub`, window `title: ZimeSub`, `1280×800`, `minWidth: 1024`, `minHeight: 720`, `dragDropEnabled: true`. |
| `src-tauri/Cargo.toml` | Renamed crate to `zimesub` / lib `zimesub_lib`, updated description, authors, repository, `default-run`. |
| `src-tauri/src/main.rs` | Updated `app_lib::run()` → `zimesub_lib::run()`. |
| `index.html` | `lang="vi"`, title `ZimeSub`, theme-color `#0A0A0A`, Vietnamese noscript message. |
| `src/App.tsx` | Replaced starter Header/Main/Footer render with `<AppShell />`. |
| `src/index.tsx` | Added defensive null-check on `#root` to satisfy TS strict types. |
| `src/index.css` | Imported Geist Sans/Mono CSS, declared full ZimeSub palette + font tokens via Tailwind v4 `@theme`, base styles for body / selection / Lucide stroke-width. |
| `tsconfig.json` | Migrated off deprecated `moduleResolution: node` + `baseUrl` to `moduleResolution: Bundler` + tsconfig-relative path aliases (added `@lib/*`). |

### Files deleted

| File | Reason |
|---|---|
| `src/components/Header.tsx` | Starter "Welcome to My App" header — replaced by `Sidebar` wordmark. |
| `src/components/Main.tsx` | Starter "Tauri + Solid + Tailwind + TypeScript" link cluster — replaced by `EmptyProjectsState`. |
| `src/components/Footer.tsx` | Starter author footer — replaced by `StatusBar`. |
| `src/components/Link.tsx` | Helper used only by the starter Footer/Main. |
