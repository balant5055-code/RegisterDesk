// Marketing journey kit — TimelineBadge. The white icon-node that sits on the
// connector line. Matches the hero's floating icon-surfaces: hairline border,
// soft shadow, brand icon. Reusable (journey · platform pipelines). Server
// component; hover is pure CSS via a parent `group`.

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export function TimelineBadge({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span
      className={cn(
        'relative z-10 flex size-[52px] shrink-0 items-center justify-center rounded-2xl border border-border/50 bg-white shadow-sm transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-md',
        className,
      )}
    >
      <Icon className="size-5 text-primary" strokeWidth={1.7} aria-hidden />
    </span>
  )
}
