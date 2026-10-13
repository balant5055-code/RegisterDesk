'use client'

// RD-PRINT-BILL-P6 · The confirmation (and progress) dialog for badge generation, driven entirely by
// useBadgeGeneration's state. Every figure is the SERVER's quote: cards, free reprints, attendees to
// bill, units available, shortfall and the GST-inclusive unit price. Nothing is calculated here.

import Link from 'next/link'
import { Loader2, CheckCircle2, IdCard, Info, ArrowUpRight, Clock } from 'lucide-react'
import { Button, Dialog } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { increaseLimitHref } from '@/lib/wallet/purchaseIntent'
import type { PrintBadgeQuote } from '@/lib/printAssets/generationJob'
import type { BadgeGenerationState } from './useBadgeGeneration'

const n = (v: number) => v.toLocaleString('en-IN')

const REASON_TEXT: Record<string, string> = {
  required: 'These cards use prepaid ID badges. Review and confirm to continue.',
  invalid:  'The selection changed since this was quoted. Review the new figures.',
  expired:  'The earlier quote expired. Review the current figures.',
  changed:  'More attendees need a new badge than before. Review the new figures.',
}

export interface BadgeQuoteDialogProps {
  open:     boolean
  state:    BadgeGenerationState
  /** From useWorkspacePermissions — advisory only; the server enforces owner-only billing. */
  isOwner:  boolean
  /** The event's DRAFT id, for the License & Services hand-off (Buy ID badges). */
  draftId:  string | null
  title?:   string
  onConfirm: () => void
  /** Re-send the SAME request (after a timed-out wait or a retryable error). */
  onResume:  () => void
  /** Start over as a NEW intent (after a conflict / billing change). */
  onRestart: () => void
  onClose:   () => void
  /** Where the job can be followed. */
  trackHref?: string
}

export function BadgeQuoteDialog(p: BadgeQuoteDialogProps) {
  const s = p.state
  const working = s.phase === 'quoting' || s.phase === 'submitting'
  return (
    <Dialog open={p.open} onClose={p.onClose} title={p.title ?? 'Generate ID badges'} closeOnBackdrop={!working}
      footer={<Footer {...p} />}>
      <div className="space-y-3 text-[13px]" aria-live="polite">
        {s.phase === 'quoting' && <Working text="Checking ID badges for this selection…" />}
        {s.phase === 'submitting' && <Working text="Starting the print job…" />}
        {s.phase === 'confirm' && <QuoteBody quote={s.quote} reason={s.reason} isOwner={p.isOwner} draftId={p.draftId} />}
        {s.phase === 'waiting' && (
          <div className="flex items-start gap-3 rounded-xl bg-surface-3 p-3">
            <Clock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="font-semibold text-foreground">Still creating…</p>
              <p className="mt-0.5 text-muted-foreground">This print job is already being set up. We&apos;ll keep checking for a few minutes — nothing will be charged twice.</p>
            </div>
          </div>
        )}
        {s.phase === 'timeout' && (
          <Notice tone="warn" title="Still not finished">
            The job is taking longer than expected. Check again in a moment — it is the same request, so it is never created twice.
          </Notice>
        )}
        {s.phase === 'done' && (
          <div className="flex items-start gap-3 rounded-xl bg-emerald-50 p-3 text-emerald-800">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{s.existing ? 'This print job was already created — no new job was started.' : 'The print job has started. Cards appear in Print Operations as they finish.'}</p>
          </div>
        )}
        {s.phase === 'blocked' && <Blocked outcome={s.outcome} draftId={p.draftId} />}
      </div>
    </Dialog>
  )
}

function QuoteBody({ quote: q, reason, isOwner, draftId }: { quote: PrintBadgeQuote; reason: string | null; isOwner: boolean; draftId: string | null }) {
  const allFree = q.chargeable === 0
  return (
    <>
      {reason && REASON_TEXT[reason] && <Notice tone="info">{REASON_TEXT[reason]}</Notice>}
      <div className="rounded-xl bg-surface-3 p-3">
        <div className="flex items-center gap-2">
          <IdCard className="size-4 text-primary" aria-hidden />
          <p className="font-semibold text-foreground">{n(q.eligible)} card{q.eligible === 1 ? '' : 's'} in this selection</p>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fig label="Free reprints" value={n(q.previouslyBilled)} hint="Already billed" />
          <Fig label="To bill" value={n(q.chargeable)} hint="1 badge each" strong />
          <Fig label="Available" value={n(q.available)} hint="ID badges" />
          <Fig label="Short by" value={n(q.shortfall)} hint={q.shortfall > 0 ? 'Buy more' : '—'} warn={q.shortfall > 0} />
        </dl>
        {q.unitPricePaise !== null && !allFree && (
          <p className="mt-2 text-[12px] text-muted-foreground">Badges are prepaid at {formatPaise(q.unitPricePaise)} each, incl. GST. Attendees already billed on this event print free.</p>
        )}
      </div>
      {allFree && <Notice tone="ok">Every attendee here has already been billed on this event — these are free reprints.</Notice>}
      {q.shortfall > 0 && (
        <Notice tone="primary" title={`Needs ${n(q.shortfall)} more ID badge${q.shortfall === 1 ? '' : 's'}`}>
          {draftId && isOwner
            ? <Link href={increaseLimitHref(draftId, 'print_badges')} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">Buy ID badges <ArrowUpRight className="size-3.5" aria-hidden /></Link>
            : 'Ask the workspace owner to buy more ID badges.'}
        </Notice>
      )}
      {q.ownerRequired && !isOwner && !allFree && (
        <Notice tone="info" title="Owner approval needed">Only the workspace owner can start a print job that bills attendees. Free reprints are still available to you.</Notice>
      )}
    </>
  )
}

/** Can the organizer confirm this quote? Mirrors the server's refusals so the button is honest. */
export function canConfirmQuote(q: PrintBadgeQuote, isOwner: boolean): boolean {
  if (q.chargeable === 0) return true
  return q.shortfall === 0 && (!q.ownerRequired || isOwner)
}

function Footer(p: BadgeQuoteDialogProps) {
  const s = p.state
  if (s.phase === 'confirm') {
    const ok = canConfirmQuote(s.quote, p.isOwner)
    return (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={p.onClose}>Cancel</Button>
        <Button size="sm" onClick={p.onConfirm} disabled={!ok}>
          {s.quote.chargeable === 0 ? 'Print free reprints' : `Use ${n(s.quote.chargeable)} ID badge${s.quote.chargeable === 1 ? '' : 's'} & generate`}
        </Button>
      </div>
    )
  }
  if (s.phase === 'timeout') {
    return <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={p.onClose}>Close</Button><Button size="sm" onClick={p.onResume}>Check again</Button></div>
  }
  if (s.phase === 'done') {
    return (
      <div className="flex justify-end gap-2">
        {p.trackHref && <Link href={p.trackHref} className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-semibold text-primary hover:bg-primary/[0.06]">Track job</Link>}
        <Button size="sm" onClick={p.onClose}>Done</Button>
      </div>
    )
  }
  if (s.phase === 'blocked') {
    const o = s.outcome
    return (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={p.onClose}>Close</Button>
        {o.kind === 'error' && o.retryable && <Button size="sm" onClick={p.onResume}>Try again</Button>}
        {(o.kind === 'conflict' || o.kind === 'billing_changed') && <Button size="sm" onClick={p.onRestart}>Start again</Button>}
      </div>
    )
  }
  return <div className="flex justify-end"><Button variant="ghost" size="sm" onClick={p.onClose} disabled={s.phase === 'submitting'}>Close</Button></div>
}

function Blocked({ outcome: o, draftId }: { outcome: Extract<BadgeGenerationState, { phase: 'blocked' }>['outcome']; draftId: string | null }) {
  if (o.kind === 'insufficient') {
    return (
      <Notice tone="primary" title={o.quote ? `Needs ${n(o.quote.shortfall)} more ID badge${o.quote.shortfall === 1 ? '' : 's'}` : 'Not enough ID badges'}>
        <p>{o.message}</p>
        {draftId && <Link href={increaseLimitHref(draftId, 'print_badges')} className="mt-1 inline-flex items-center gap-1 font-semibold text-primary hover:underline">Buy ID badges <ArrowUpRight className="size-3.5" aria-hidden /></Link>}
      </Notice>
    )
  }
  if (o.kind === 'owner_required') return <Notice tone="info" title="Owner approval needed">{o.message}</Notice>
  if (o.kind === 'conflict') return <Notice tone="warn" title="This request was already used">{o.message} Start again to create a new print job.</Notice>
  if (o.kind === 'billing_changed') return <Notice tone="warn" title="The job changed">{o.message}</Notice>
  if (o.kind === 'busy') return <Notice tone="info" title="The job is running">{o.message}. Try again when it finishes.</Notice>
  return <Notice tone="warn">{o.message}</Notice>
}

function Working({ text }: { text: string }) {
  return <div className="flex items-center gap-2 py-2 text-muted-foreground"><Loader2 className="size-4 animate-spin text-primary" aria-hidden />{text}</div>
}

function Fig({ label, value, hint, strong, warn }: { label: string; value: string; hint: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-card px-2.5 py-2 shadow-[0_0_0_1px_var(--border)]">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 tabular-nums', strong ? 'text-[18px] font-bold text-primary' : 'text-[15px] font-semibold text-foreground', warn && 'text-hero-violet')}>{value}</dd>
      <p className="truncate text-[10.5px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function Notice({ tone, title, children }: { tone: 'info' | 'warn' | 'ok' | 'primary'; title?: string; children: React.ReactNode }) {
  return (
    <div role={tone === 'warn' ? 'alert' : 'status'} className={cn('flex gap-2.5 rounded-xl p-3 text-[12.5px]',
      tone === 'primary' && 'bg-primary/[0.06] text-foreground ring-1 ring-primary/20',
      tone === 'info' && 'bg-surface-3 text-foreground',
      tone === 'warn' && 'bg-amber-50 text-amber-900',
      tone === 'ok' && 'bg-emerald-50 text-emerald-800')}>
      <Info className={cn('mt-0.5 size-4 shrink-0', tone === 'primary' ? 'text-primary' : 'opacity-70')} aria-hidden />
      <div className="min-w-0">{title && <p className="font-semibold">{title}</p>}<div className={cn(title && 'mt-0.5')}>{children}</div></div>
    </div>
  )
}
