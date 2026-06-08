import { splitProps, type Component, type JSX, type ParentProps } from 'solid-js'

/**
 * Square-ish flat button used across ZimeSub.
 *
 * Sizing: 44px minimum hit target, padding 12×20 (per docs/style-guide.md).
 * Border is the section-separator language — no shadow, no gradient, no blur.
 *
 *  - `primary`: accent fill, used for one CTA per view ("Quét lại", …)
 *  - `secondary`: bg fill + 2px border, used for everything else
 *
 * Children are typically icon + label; gap is 8px (`gap-2`).
 */
type Variant = 'primary' | 'secondary'

interface OwnProps {
  variant?: Variant
}

type ButtonProps = ParentProps<OwnProps & JSX.ButtonHTMLAttributes<HTMLButtonElement>>

const variantClasses: Record<Variant, string> = {
  primary:
    'border-2 border-accent bg-accent text-accent-on-accent hover:border-text-muted hover:bg-text hover:text-bg disabled:border-border disabled:bg-border disabled:text-text-muted',
  secondary:
    'border-2 border-border bg-bg text-text hover:border-accent hover:text-accent disabled:hover:border-border disabled:hover:text-text'
}

const Button: Component<ButtonProps> = props => {
  const [local, rest] = splitProps(props, ['variant', 'class', 'children', 'type'])
  return (
    <button
      type={local.type ?? 'button'}
      class={[
        'inline-flex h-11 min-w-11 items-center justify-center gap-2 px-5 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70',
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
