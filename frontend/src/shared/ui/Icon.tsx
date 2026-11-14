import { ICON_PATHS, ICON_VIEWBOX, type IconName } from './iconPaths.ts'

interface Props {
  name: IconName
  /** Pixel size; the glyph is square. */
  size?: number
  className?: string
}

/** Decorative by design: the label next to it names the control. */
export function Icon({ name, size = 20, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}
