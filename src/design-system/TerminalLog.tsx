import { createEffect, For, on, type Component } from 'solid-js'

/**
 * Mono-font, terminal-styled log panel for streaming subprocess output.
 *
 * Used by the Onboarding view for winget install output (slice 0003) and
 * later by the Jobs panel for ffmpeg/mkvextract stderr. Auto-scrolls to
 * the bottom whenever a new line is appended so the user always sees the
 * latest progress without manual scrolling.
 *
 * stderr lines are tinted `warn` so failures stand out against the bulk
 * stdout output, but no semantic level inference is done — winget routinely
 * uses stderr for non-error progress messages, so flagging them as errors
 * would be misleading.
 */
export interface TerminalLogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

interface TerminalLogProps {
  lines: TerminalLogLine[]
  ariaLabel?: string
  emptyHint?: string
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
      class="h-64 overflow-y-auto border-2 border-border bg-bg p-3 font-mono text-xs leading-relaxed"
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
