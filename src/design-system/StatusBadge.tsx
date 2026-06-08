import type { Component, JSX } from 'solid-js'

/**
 * Rounded pill status badge used in lists, tables, and pipeline
 * steppers (RequiredTool rows, EpisodeState, JobStatus chips).
 *
 * Two visual densities: `solid` (filled tint, used for definitive
 * states like Ready / Đã extract) and `outline` (text on transparent
 * tint, used for transient or informational states). The pill radius
 * keeps the language consistent with Buttons and Cards.
 */
export type BadgeTone = 'accent' | 'warn' | 'danger' | 'neutral'
export type BadgeVariant = 'solid' | 'outline'

interface StatusBadgeProps {
  tone: BadgeTone
  variant?: BadgeVariant
  children: JSX.Element
}

const solidClasses: Record<BadgeTone, string> = {
  accent: 'bg-accent-soft text-accent border border-accent-soft',
  warn: 'bg-warn-soft text-warn border border-warn-soft',
  danger: 'bg-danger-soft text-danger border border-danger-soft',
  neutral: 'bg-elevated text-text-muted border border-elevated'
}

const outlineClasses: Record<BadgeTone, string> = {
  accent: 'border border-accent/40 text-accent bg-transparent',
  warn: 'border border-warn/40 text-warn bg-transparent',
  danger: 'border border-danger/40 text-danger bg-transparent',
  neutral: 'border border-border text-text-muted bg-transparent'
}

const StatusBadge: Component<StatusBadgeProps> = props => {
  const variant = (): BadgeVariant => props.variant ?? 'solid'
  return (
    <span
      class={[
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] uppercase',
        variant() === 'solid' ? solidClasses[props.tone] : outlineClasses[props.tone]
      ].join(' ')}
    >
      {props.children}
    </span>
  )
}

export default StatusBadge
