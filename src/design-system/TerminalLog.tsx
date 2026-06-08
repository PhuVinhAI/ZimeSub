import { createEffect, For, on, type Component } from 'solid-js'

/**
 * Mono-font, terminal-styled log panel for streaming subprocess output.
 *
 * Used by Onboarding (winget install output), the Jobs panel (ffmpeg
 * stderr), and the track picker (mkvmerge failures). Auto-scrolls to
 * the bottom whenever a new line is appended.
 *
 * stderr lines are tinted `warn` so failures stand out against stdout,
 * but no semantic level inference is done — winget routinely uses
 * stderr for non-error progress messages.
 */
export interface TerminalLogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

interface TerminalLogProps {
  lines: TerminalLogLine[]
  ariaLabel?: string
  emptyHint?: string
  /** Overrides the default 16rem height; useful in slim layouts. */
  heightClass?: string
}

const TerminalLog: Component<TerminalLogProps> = props => {
  let scrollEl: HTMLDivElement | undefined

  createEffect(
    on(
      () => props.lines.length,
      () => {
        if (!scrollEl) return
        scrollEl.scrollTop = scrollEl.scrollHeight
      }
    )
  )

  return (
    <div
      ref={el => {
        scrollEl = el
      }}
      class={[
        'overflow-y-auto rounded-2xl border border-border bg-bg p-4 font-mono text-xs leading-relaxed',
        props.heightClass ?? 'h-64'
      ].join(' ')}
      role="log"
      aria-live="polite"
      aria-label={props.ariaLabel ?? 'Nhật ký công cụ'}
    >
      {props.lines.length === 0 ? (
        <p class="text-text-muted">{props.emptyHint ?? 'Chưa có dữ liệu.'}</p>
      ) : (
        <For each={props.lines}>
          {line => (
            <pre
              class={[
                'whitespace-pre-wrap break-words',
                line.stream === 'stderr' ? 'text-warn' : 'text-text'
              ].join(' ')}
            >
              {line.text}
            </pre>
          )}
        </For>
      )}
    </div>
  )
}

export default TerminalLog
