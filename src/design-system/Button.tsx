import { splitProps, type Component, type JSX, type ParentProps } from 'solid-js'

/**
 * Rounded flat button used across ZimeSub.
 *
 * Sizing: 44px minimum hit target, padding 12×22.
 * No shadow, no gradient, no blur — the rounded silhouette plus the
 * single accent colour does the visual work.
 *
 *  - `primary`:   accent fill, used for the one CTA per view
 *  - `secondary`: elevated surface, used for everything else
 *  - `ghost`:     transparent until hover, used for inline / icon-only
 *  - `danger`:    destructive — accent swapped for red
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

interface OwnProps {
  variant?: Variant
  size?: Size
}

type ButtonProps = ParentProps<OwnProps & JSX.ButtonHTMLAttributes<HTMLButtonElement>>

const variantClasses: Record<Variant, string> = {
  primary:
    'border border-accent bg-accent text-accent-on-accent hover:bg-text hover:border-text hover:text-bg disabled:border-border disabled:bg-elevated disabled:text-text-faint',
  secondary:
    'border border-border bg-elevated text-text hover:border-accent hover:text-accent disabled:hover:border-border disabled:hover:text-text-muted',
  ghost:
    'border border-transparent bg-transparent text-text-muted hover:bg-elevated hover:text-text disabled:hover:bg-transparent disabled:hover:text-text-faint',
  danger:
    'border border-danger bg-danger text-bg hover:bg-bg hover:text-danger disabled:border-border disabled:bg-elevated disabled:text-text-faint'
}

const sizeClasses: Record<Size, string> = {
  sm: 'h-9 min-w-9 gap-1.5 rounded-xl px-3.5 text-xs',
  md: 'h-11 min-w-11 gap-2 rounded-2xl px-5 text-sm'
}

const Button: Component<ButtonProps> = props => {
  const [local, rest] = splitProps(props, [
    'variant',
    'size',
    'class',
    'children',
    'type'
  ])
  return (
    <button
      type={local.type ?? 'button'}
      class={[
        'inline-flex items-center justify-center font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-70',
        sizeClasses[local.size ?? 'md'],
        variantClasses[local.variant ?? 'secondary'],
        local.class ?? ''
      ].join(' ')}
      {...rest}
    >
      {local.children}
    </button>
  )
}

export default Button
