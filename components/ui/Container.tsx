import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

interface ContainerProps extends HTMLAttributes<HTMLElement> {
  /** Render as any block-level element — defaults to div */
  as?: ElementType
}

export function Container({
  as: Tag = 'div',
  className,
  children,
  ...props
}: ContainerProps) {
  return (
    <Tag
      className={cn('mx-auto w-full max-w-[1280px] px-4 sm:px-6 lg:px-8', className)}
      {...props}
    >
      {children}
    </Tag>
  )
}
