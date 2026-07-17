// Marketing product UI kit — BrowserFrame. Frames a product surface in a clean
// browser chrome (traffic lights · URL pill · notification + account) so it reads
// as a real app. Reusable. Layered depth shadow (crisp edge + soft ambient float)
// for premium elevation — never a harsh shadow-2xl.

import type { ReactNode } from 'react'
import { Lock, Bell } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export function BrowserFrame({ url, children, className }: { url: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border/60 bg-white shadow-md', className)}>
      <div className="flex items-center gap-2 border-b border-border/60 bg-gradient-to-b from-muted/40 to-muted/20 px-4 py-2.5">
        <span className="flex shrink-0 gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-rose-300" />
          <span className="size-2.5 rounded-full bg-amber-300" />
          <span className="size-2.5 rounded-full bg-emerald-300" />
        </span>
        <div className="mx-auto flex min-w-0 max-w-sm flex-1 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-white px-3 py-1 text-fs-2xs text-muted-foreground shadow-sm">
          <Lock className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
          <span className="truncate">{url}</span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex" aria-hidden>
          <Bell className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
          <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary">A</span>
        </div>
      </div>
      {children}
    </div>
  )
}
