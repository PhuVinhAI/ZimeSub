# ZimeSub Style Guide

Pure flat design. **No gradient, no shadow, no blur.** All separators are thick solid borders.

## Color

Dark-only. Single accent.

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0A0A0A` | Window background |
| `surface` | `#141414` | Panel/card background (slight contrast from bg) |
| `border` | `#262626` | Default border (2px) |
| `border-strong` | `#FFFFFF` | Active/selected border (3px) |
| `text` | `#F5F5F5` | Primary text |
| `text-muted` | `#737373` | Secondary text |
| `accent` | `#00FF66` | Electric green — used for active state, progress bar, primary CTAs |
| `accent-on-accent` | `#000000` | Text on accent backgrounds |
| `danger` | `#FF3B30` | Errors, destructive actions |
| `warn` | `#FFB800` | Warnings, outdated tool |

Forbidden Tailwind classes: any `shadow-*`, `bg-gradient-*`, `backdrop-blur-*`, `drop-shadow-*`. Add a lint check during implementation.

## Typography

- **Sans**: Geist Sans (variable weight). Self-hosted.
- **Mono**: Geist Mono. Used for: log stream, file paths, version strings.
- Display sizes are large by default — page titles `text-5xl` (48px), section headings `text-2xl` (24px), body `text-base` (16px) but with generous line-height.

## Layout shell

```
┌────────────────────────────────────────────────────────────────┐
│  [Sidebar]                  [Main content]                     │
│  ─────────                  ─────────────                      │
│  ZIMESUB                                                       │
│                                                                │
│  PROJECTS                                                      │
│  ▸ Oi Tonbo S2 (12)         <Current Project view>            │
│  ▸ Spy x Family S2 (8)                                         │
│                                                                │
│  ＋ New project                                                │
│                                                                │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  JOBS  ●●○○○  3/12  EP05 Render — frame 14523 / 34201  ▰▰▰▱   │
└────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (left, fixed 280px): project list + "New project" CTA. Active project has 3px left accent border.
- **Main**: current project (Episode list + per-episode pipeline panel).
- **Bottom status bar** (fixed 56px): JobQueue summary + currently running job's progress (parsed %). Click to expand a full Jobs panel.

## Drag & drop

When the user drags any file over the app window with a Project open: a **full-window overlay** appears (semi-opaque `bg` at 0.92 alpha + 3px dashed `accent` border inset 24px) with a large centered label "Thả file MKV vào đây để thêm Episode". Overlay disappears on drop or dragleave.

## Language

UI is **Vietnamese**. Code identifiers, log output, technical terms in CONTEXT.md/ADRs stay in English. No i18n framework in v1.

## Density & spacing

- Min hit target 44×44 px.
- Section gaps: 32px.
- Field gaps: 16px.
- Inline gaps: 8px.
- Buttons: padding `12px 20px`, no rounding above `rounded` (4px). Square is fine.

## Iconography

Lucide icon set (consistent stroke, free, self-hosted). Always 1.5px stroke. No filled icons.
