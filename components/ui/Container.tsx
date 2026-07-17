import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'
import { container, type ContainerSize } from '@/lib/ds/containers'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContainerProps extends HTMLAttributes<HTMLElement> {
  /** Render as any block-level element — defaults to div */
  as?: ElementType
  /**
   * Layout width preset.
   *
   * - `page`    1280px  Full-width sections and page layouts (default)
   * - `content`  820px  Centered prose / article bodies
   * - `modal`    576px  Dialog and overlay surfaces
   * - `auth`     420px  Auth page forms
   * - `narrow`   320px  Paragraph text constraints
   */
  size?: ContainerSize
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Container({
  as: Tag  = 'div',
  size     = 'page',
  className,
  children,
  ...props
}: ContainerProps) {
  return (
    <Tag
      className={cn(container[size], className)}
      {...props}
    >
      {children}
    </Tag>
  )
}
