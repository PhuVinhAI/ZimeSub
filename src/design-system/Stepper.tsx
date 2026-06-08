import { Check } from 'lucide-solid'
import { For, Show, type Component, type JSX } from 'solid-js'

/**
 * Horizontal wizard stepper used to anchor pipeline-like views.
 *
 * Each step renders a numbered circle + label + optional sublabel; the
 * connecting line tinted with the current step's tone visualises
 * progress without resorting to gradients (which the style guide
 * forbids — depth comes from fill colour alone).
 *
 * Status legend:
 *  - `done`:    accent-filled circle with check icon
 *  - `current`: accent outline circle, accent number
 *  - `upcoming`: muted outline circle
 *  - `error`:   danger-filled circle
 *  - `skipped`: muted outline + low-opacity label
 *
 * The component is layout-only — clicking a step does NOT navigate;
 * the consumer is free to wrap each step in a button if needed
 * (we attach `onStepClick` for that hook).
 */
export type StepStatus = 'done' | 'current' | 'upcoming' | 'error' | 'skipped'

export interface Step {
  id: string
  label: string
  sublabel?: string
  status: StepStatus
  icon?: JSX.Element
}

interface StepperProps {
  steps: Step[]
  /** Optional handler for click-to-jump UX (e.g. settings wizards). */
  onStepClick?: (id: string) => void
  /** Layout variant. `comfortable` is the default for the project header;
   *  `compact` is for per-row pipelines inside Episode cards. */
  size?: 'compact' | 'comfortable'
}

const sizeTokens = {
  compact: {
    bullet: 'h-7 w-7 text-[11px]',
    label: 'text-[11px] tracking-[0.16em]',
    sublabel: 'text-[10px]',
    icon: 14,
    gap: 'gap-2',
    line: 'h-px'
  },
  comfortable: {
    bullet: 'h-10 w-10 text-sm',
    label: 'text-xs tracking-[0.22em]',
    sublabel: 'text-xs',
    icon: 18,
    gap: 'gap-3',
    line: 'h-px'
  }
} as const

const Stepper: Component<StepperProps> = props => {
  const tokens = (): (typeof sizeTokens)[keyof typeof sizeTokens] =>
    sizeTokens[props.size ?? 'comfortable']

  return (
    <ol
      class={['flex w-full items-stretch', tokens().gap].join(' ')}
      role="list"
      aria-label="Tiến trình"
    >
      <For each={props.steps}>
        {(step, idx) => (
          <li class="flex min-w-0 flex-1 items-center">
            <StepBullet step={step} index={idx() + 1} tokens={tokens()} />
            <Show when={idx() < props.steps.length - 1}>
              <span
                class={[
                  'mx-3 hidden flex-1 sm:block',
                  tokens().line,
                  step.status === 'done' ? 'bg-accent' : 'bg-border'
                ].join(' ')}
                aria-hidden="true"
              />
            </Show>
          </li>
        )}
      </For>
    </ol>
  )
}

interface StepBulletProps {
  step: Step
  index: number
  tokens: (typeof sizeTokens)[keyof typeof sizeTokens]
}

const StepBullet: Component<StepBulletProps> = props => {
  const palette: Record<StepStatus, string> = {
    done: 'bg-accent text-accent-on-accent border border-accent',
    current: 'bg-transparent text-accent border border-accent',
    upcoming: 'bg-transparent text-text-muted border border-border',
    error: 'bg-danger text-bg border border-danger',
    skipped: 'bg-transparent text-text-faint border border-border'
  }

  const labelColor: Record<StepStatus, string> = {
    done: 'text-text',
    current: 'text-text',
    upcoming: 'text-text-muted',
    error: 'text-danger',
    skipped: 'text-text-faint'
  }

  return (
    <div class="flex min-w-0 items-center gap-3">
      <span
        class={[
          'flex flex-none items-center justify-center rounded-full font-mono font-semibold',
          props.tokens.bullet,
          palette[props.step.status]
        ].join(' ')}
        aria-hidden="true"
      >
        <Show
          when={props.step.status === 'done'}
          fallback={
            <Show when={props.step.icon} fallback={String(props.index).padStart(2, '0')}>
              {props.step.icon}
            </Show>
          }
        >
          <Check size={props.tokens.icon} strokeWidth={2} aria-hidden="true" />
        </Show>
      </span>
      <div class="flex min-w-0 flex-col">
        <span
          class={[
            'font-mono font-semibold uppercase',
            props.tokens.label,
            labelColor[props.step.status]
          ].join(' ')}
        >
          {props.step.label}
        </span>
        <Show when={props.step.sublabel}>
          <span class={['truncate text-text-muted', props.tokens.sublabel].join(' ')}>
            {props.step.sublabel}
          </span>
        </Show>
      </div>
    </div>
  )
}

export default Stepper
