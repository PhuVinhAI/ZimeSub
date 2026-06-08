import type { Component, JSX } from 'solid-js'

/**
 * Compact status pill used in tables/lists (RequiredTool rows for now, later
 * EpisodeState badges, JobStatus chips, etc.).
 *
 * Three tones map to the docs/style-guide.md tokens:
 *  - `accent`: success — electric green border + accent text
 *  - `warn`:   needs-attention — amber border + amber text
 *  - `danger`: blocking — red border + red text
 */
export type BadgeTone = 'accent' | 'warn' | 'danger'

interface StatusBadgeProps {
  tone: BadgeTone
  children: JSX.Element
}

const toneClasses: Record<BadgeTone, string> = {
  accent: 'border-accent text-accent',
  warn: 'border-warn text-warn',
  danger: 'border-danger text-danger'
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
