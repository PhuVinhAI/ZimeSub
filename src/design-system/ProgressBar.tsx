import type { Component } from 'solid-js'

/**
 * Flat determinate progress bar used by Episode rows during extract /
 * render jobs.
 *
 * Style follows the pure flat dark guide — 2 px border track, accent
 * fill, no rounded corners or gradient. Track height is 8 px which
 * sits comfortably inside the 56 px Episode row without crowding the
 * adjacent badges. The accent fill width is driven by the `ratio`
 * prop clamped to `[0, 1]`; values outside that range are bounded
 * defensively (a parser bug shouldn't paint the bar past 100% or as
 * a sliver of negative width).
 *
 * `ariaLabel` is required so screen readers can announce the running
 * job; `ariaValueText` falls back to the percentage if not provided
 * (Jobs panel uses the richer ffmpeg `time= / total` string in a
 * later slice).
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
      class="h-2 w-full border-2 border-border bg-bg"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent()}
      aria-valuetext={props.ariaValueText ?? `${percent()}%`}
      aria-label={props.ariaLabel}
    >
      <div
        class="h-full bg-accent transition-[width] duration-150 ease-out"
        style={{ width: `${percent()}%` }}
      />
    </div>
  )
}

export default ProgressBar
