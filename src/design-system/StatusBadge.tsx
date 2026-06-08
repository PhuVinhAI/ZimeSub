import type { Component, JSX } from 'solid-js'

/**
 * Compact status pill used in tables/lists (RequiredTool rows for now, later
 * EpisodeState badges, JobStatus chips, etc.).
 *
 * Tones map to the docs/style-guide.md tokens:
 *  - `accent`:  success — electric green border + accent text
 *  - `warn`:    needs-attention — amber border + amber text
 *  - `danger`:  blocking — red border + red text
 *  - `neutral`: informational — muted border + muted text. Slice 0006
 *               uses this for the Episode-row language tag so it sits
 *               next to the accent state badge ("Trống") without
 *               competing visually.
 */
export type BadgeTone = 'accent' | 'warn' | 'danger' | 'neutral'

interface StatusBadgeProps {
  tone: BadgeTone
  children: JSX.Element
}

const toneClasses: Record<BadgeTone, string> = {
  accent: 'border-accent text-accent',
  warn: 'border-warn text-warn',
  danger: 'border-danger text-danger',
  neutral: 'border-text-muted text-text-muted'
}

const StatusBadge: Component<StatusBadgeProps> = props => {
  return (
    <span
      class={[
        'inline-flex items-center gap-1.5 border-2 bg-bg px-2.5 py-1 font-mono text-xs font-medium tracking-wide uppercase',
        toneClasses[props.tone]
      ].join(' ')}
    >
      {props.children}
    </span>
  )
}

export default StatusBadge
