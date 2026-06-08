import type { Component } from 'solid-js'

/**
 * Rounded determinate progress bar used during extract / render jobs.
 *
 * Track is a 6px pill — full radius makes the fill bar feel like a
 * "liquid" capsule even at 1% progress. No gradient or shadow; pure
 * accent colour on the elevated surface tone.
 *
 * `ratio` is clamped to `[0, 1]` defensively so a parser bug never
 * paints the bar past 100% or as negative width.
 */
interface ProgressBarProps {
  /** Fraction in `[0, 1]`. Clamped before rendering. */
  ratio: number
  /** Accessible name for the bar (e.g. "Đang trích xuất phụ đề"). */
  ariaLabel: string
  /** Optional human-readable form of the current value. */
  ariaValueText?: string
}

const ProgressBar: Component<ProgressBarProps> = props => {
  const clamped = (): number => Math.max(0, Math.min(1, props.ratio))
  const percent = (): number => Math.round(clamped() * 100)

  return (
    <div
      class="h-1.5 w-full overflow-hidden rounded-full bg-elevated"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent()}
      aria-valuetext={props.ariaValueText ?? `${percent()}%`}
      aria-label={props.ariaLabel}
    >
      <div
        class="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
        style={{ width: `${percent()}%` }}
      />
    </div>
  )
}

export default ProgressBar
