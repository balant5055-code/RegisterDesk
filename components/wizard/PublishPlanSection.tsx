'use client'

// RD-PUBLISH-PLAN · the compact "Your Plan & Included Services" block inside the publish
// confirmation. Presentation only — rows come from buildPlanSummary (the server quote).

import { cn } from '@/lib/utils/cn'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { groupPlanItems, type PlanItem, type PlanItemStatus } from './publishPlanSummary'

const TAG: Record<PlanItemStatus, { text: string; cls: string }> = {
  included:    { text: 'Included',     cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
  paid:        { text: 'Paid add-on',  cls: 'bg-primary/10 text-primary-text' },
  purchased:   { text: 'Paid',         cls: 'bg-primary/10 text-primary-text' },
  off:         { text: 'Off',          cls: 'bg-muted text-muted-foreground' },
  available:   { text: 'Not selected', cls: 'bg-muted text-muted-foreground' },
  unavailable: { text: 'Not available', cls: 'bg-muted text-muted-foreground' },
}

function Row({ item }: { item: PlanItem }) {
  const tag = TAG[item.status]
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-2" data-plan-item={item.key} data-plan-status={item.status}>
      <div className="min-w-0">
        <p className="text-[13px] text-foreground">{item.label}</p>
        {item.detail && <p className="text-[11.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span className="text-[13px] font-medium tabular-nums text-foreground">{item.value}</span>
        {/* The tag only where it adds something ("Off" beside "Off" says nothing). */}
        {tag.text.toLowerCase() !== item.value.toLowerCase() && (
          <span className={cn('rounded-full px-1.5 py-px text-[10.5px] font-semibold', tag.cls)}>{tag.text}</span>
        )}
      </div>
    </li>
  )
}

function Group({ title, items }: { title: string; items: PlanItem[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="bg-muted/30 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="divide-y divide-border/40">{items.map(i => <Row key={i.key} item={i} />)}</ul>
    </div>
  )
}

export function PublishPlanSection({ items, payablePaise, covered }: {
  /** null — no current quote (still calculating, or it could not be loaded). */
  items:        PlanItem[] | null
  payablePaise: number | null
  covered:      boolean
}) {
  return (
    <section aria-labelledby="publish-plan-heading" data-testid="publish-plan" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border/40 px-4 py-2.5">
        <p id="publish-plan-heading" className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Your Plan &amp; Included Services</p>
      </div>
      {items === null ? (
        <p className="px-4 py-3 text-[12.5px] text-muted-foreground">
          Plan details aren’t available right now. Check License &amp; Services for your capacity and services.
        </p>
      ) : (
        <>
          {(() => {
            const g = groupPlanItems(items)
            return (
              <div className="divide-y divide-border/40">
                <Group title="Included" items={g.included} />
                <Group title="Paid add-ons" items={g.paid} />
                <Group title="Not included" items={g.other} />
              </div>
            )
          })()}
          <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-2.5">
            <span className="text-[12.5px] font-semibold text-foreground">Payable now</span>
            <span className="text-[13px] font-bold tabular-nums text-foreground" data-testid="publish-plan-payable">
              {covered ? 'Nothing to pay' : payablePaise === null ? '—' : formatPaise(payablePaise)}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
