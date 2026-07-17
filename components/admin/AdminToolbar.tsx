import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── AdminToolbar ───────────────────────────────────────────────────────────────
// The page title block shared by every Platform Admin page: title (+ optional
// leading icon), optional description, and an optional right-aligned actions slot
// (export / refresh / primary buttons). Matches the existing inline admin header
// exactly, so pages that only had `<h1>` + `<p>` render identically.

export interface AdminToolbarProps {
  title:        string
  description?: string
  /** Optional leading icon shown before the title. */
  icon?:        LucideIcon
  /** Right-aligned actions (buttons, links). */
  actions?:     ReactNode
  className?:   string
}

export function AdminToolbar({ title, description, icon: Icon, actions, className }: AdminToolbarProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground">
          {Icon && <Icon className="size-5 shrink-0 text-primary" aria-hidden />}
          {title}
        </h1>
        {description && (
          <p className="text-[13.5px] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
