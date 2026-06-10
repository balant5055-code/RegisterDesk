'use client'

import { cn } from '@/lib/utils/cn'
import { Ticket } from 'lucide-react'
import type { PassDetail } from '@/app/api/organizer/events/[eventId]/route'

function fmtINR(paise: number): string {
  if (paise === 0) return 'Free'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

function PassCard({ pass }: { pass: PassDetail }) {
  const remaining = pass.unlimited ? null : (pass.capacity ?? 0) - pass.sold
  const pct       = pass.unlimited || !pass.capacity ? null
    : Math.min(Math.round((pass.sold / pass.capacity) * 100), 100)

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Ticket className="size-4 text-primary" />
          </div>
          <div>
            <p className="text-[15px] font-semibold text-foreground">{pass.name}</p>
            {pass.description && (
              <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">{pass.description}</p>
            )}
          </div>
        </div>
        <span className={cn(
          'shrink-0 rounded-full px-2.5 py-1 text-[13px] font-bold',
          pass.price === 0
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-primary/10 text-primary',
        )}>
          {fmtINR(pass.price)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        {[
          { label: 'Capacity', value: pass.unlimited ? '∞' : (pass.capacity?.toLocaleString('en-IN') ?? '—') },
          { label: 'Sold',     value: pass.sold.toLocaleString('en-IN') },
          { label: 'Remaining', value: pass.unlimited ? '∞' : (remaining?.toLocaleString('en-IN') ?? '—') },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg bg-muted/40 py-2.5">
            <p className="text-[17px] font-bold tabular-nums text-foreground">{value}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {pct !== null && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{pct}% sold</p>
        </div>
      )}
    </div>
  )
}

export default function PassesTab({ passes }: { passes: PassDetail[] }) {
  if (passes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border py-20 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <Ticket className="size-6 text-muted-foreground/60" />
        </div>
        <div>
          <p className="text-[15px] font-semibold text-foreground">No passes yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Configure passes in the Settings tab.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {passes.map(p => <PassCard key={p.id} pass={p} />)}
    </div>
  )
}
