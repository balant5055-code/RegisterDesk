import { cn } from '@/lib/utils/cn'

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>

/** Token-driven loading placeholder (EA-4 S3). Decorative (aria-hidden) — the
 *  surrounding container should carry aria-busy while skeletons are shown. */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...rest} />
}
