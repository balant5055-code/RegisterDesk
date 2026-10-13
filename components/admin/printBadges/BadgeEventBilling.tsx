'use client'

// RD-PRINT-BILL-P7 · Super Admin — ONE event's ID-badge generation billing, from
// GET /api/admin/events/[slug]/print-badges/billing (audited per view). Ledger figures, claim
// counts, billing rounds, attendee claims (registration ids ONLY — no names or contacts), usage
// records, billed jobs and the Phase 5 reconciliation. Lists page by cursor ("Load more").

import { useCallback, useEffect, useState } from 'react'
import { TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, LoadMoreButton, ErrorBanner, StatusPill } from '@/components/admin'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import type { EventBillingView, RoundRow, ClaimRow, UsageRow, JobRow } from '@/lib/admin/printBadgeAdmin/eventBilling'
import { adminGet, fmtWhen, qty, type Page, type Section } from './api'
import { BadgeReconFindings, SectionBox, type ReconState } from './BadgeReconFindings'
import { usageState } from './labels'

type ListKey = 'rounds' | 'claims' | 'usage' | 'jobs'

function Fig({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-muted/40 px-3 py-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-[15px] font-semibold tabular-nums text-foreground">{value}</p></div>
}

export function BadgeEventBilling({ slug }: { slug: string }) {
  const base = `/api/admin/events/${encodeURIComponent(slug)}/print-badges/billing`
  const [view, setView] = useState<{ slug: string; data: EventBillingView | null; error: string | null } | null>(null)
  const [lists, setLists] = useState<Partial<Record<ListKey, Section<Page<unknown>>>>>({})
  const [busy, setBusy] = useState<ListKey | null>(null)

  useEffect(() => {
    let alive = true
    void adminGet<EventBillingView>(base)
      .then(d => { if (!alive) return; setView({ slug, data: d, error: null }); setLists({ rounds: d.rounds, claims: d.claims, usage: d.usage, jobs: d.jobs }) })
      .catch(e => { if (alive) setView({ slug, data: null, error: e instanceof Error ? e.message : 'Could not load badge billing' }) })
    return () => { alive = false }
  }, [base, slug])

  const more = useCallback(async (key: ListKey) => {
    const cur = lists[key]
    if (!cur || !cur.ok || !cur.data.nextCursor) return
    setBusy(key)
    try {
      const d = await adminGet<EventBillingView>(`${base}?section=${key}&cursor=${encodeURIComponent(cur.data.nextCursor)}`)
      const page = d[key] as Section<Page<unknown>> | undefined
      setLists(l => ({ ...l, [key]: page && page.ok && cur.ok ? { ok: true, data: { items: [...cur.data.items, ...page.data.items], hasMore: page.data.hasMore, nextCursor: page.data.nextCursor } } : page }))
    } catch { setLists(l => ({ ...l, [key]: { ok: false, reason: 'unavailable' } })) }
    finally { setBusy(null) }
  }, [base, lists])

  const current = view?.slug === slug ? view : null
  if (!current) return <p className="text-[12px] text-muted-foreground">Loading badge billing…</p>
  if (current.error || !current.data) return <ErrorBanner>{current.error ?? 'Badge billing is unavailable.'}</ErrorBanner>
  const v = current.data

  const recon: ReconState = !v.reconciliation ? { kind: 'loading' }
    : !v.reconciliation.ok ? { kind: 'unavailable' }
    : {
      kind: 'done',
      findings: v.reconciliation.data.problems.map(p => ({ code: p.code, ids: { round: p.roundId, job: p.jobId }, detail: p.detail })),
      partial: v.reconciliation.data.truncated ? 'Some records were beyond the read bound — this check is partial.' : null,
    }
  const list = <T,>(key: ListKey) => lists[key] as Section<Page<T>> | undefined
  const loadMore = (key: ListKey) => {
    const s = lists[key]
    return s && s.ok && s.data.hasMore ? <div className="pt-2"><LoadMoreButton onClick={() => void more(key)} loading={busy === key} /></div> : null
  }

  return (
    <div className="space-y-3" data-testid="admin-badge-billing">
      <SectionBox title="Badge units (ledger)" section={v.ledger} empty={() => false}>
        {l => (
          <>
            {!l.exists && <p className="mb-2 text-muted-foreground">No service ledger exists for this event.</p>}
            {!l.ownerMatches && <p className="mb-2 font-medium text-rose-700">The ledger belongs to a different organizer than the event.</p>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
              <Fig label="Purchased" value={qty(l.purchased)} /><Fig label="Carried in" value={qty(l.carriedIn)} />
              <Fig label="Carried out" value={qty(l.carriedOut)} /><Fig label="Refunded" value={qty(l.refunded)} />
              <Fig label="Used + reserved" value={qty(l.consumed)} /><Fig label="Available" value={qty(l.available)} />
              {v.claimCounts?.ok
                ? <Fig label="Claims (units / comp.)" value={`${qty(v.claimCounts.data.units)} / ${qty(v.claimCounts.data.complimentary)}`} />
                : <Fig label="Claims" value="Unavailable" />}
            </div>
          </>
        )}
      </SectionBox>

      <BadgeReconFindings title="Generation billing reconciliation" state={recon} />

      <SectionBox title="Billing rounds" section={list<RoundRow>('rounds')} empty={p => p.items.length === 0}>
        {p => (<>
          <TableFrame minWidth="min-w-[820px]">
            <THead><Th>Round</Th><Th>Status</Th><Th align="right">Reserved</Th><Th align="right">Claimed</Th><Th align="right">Kept</Th><Th align="right">Released</Th><Th>Quote (eligible / prior / chargeable · price)</Th><Th>Created · settled</Th></THead>
            <TBody>{p.items.map(r => (
              <Tr key={r.roundId}>
                <Td className="font-mono text-[11px]">{r.roundId}</Td>
                <Td><StatusPill tone={r.status === 'settled' ? 'success' : 'warning'}>{r.status ?? '—'}</StatusPill></Td>
                <Td align="right" className="tabular-nums">{qty(r.reserved)}</Td><Td align="right" className="tabular-nums">{qty(r.claimed)}</Td>
                <Td align="right" className="tabular-nums">{qty(r.keptUnits)}</Td><Td align="right" className="tabular-nums">{qty(r.releasedUnits)}</Td>
                <Td className="text-[12px]">{r.quote ? `${qty(r.quote.eligible)} / ${qty(r.quote.previouslyBilled)} / ${qty(r.quote.chargeable)} · ${r.quote.unitPricePaise !== null ? formatPaise(r.quote.unitPricePaise) : '—'}` : '—'}</Td>
                <Td className="text-[12px] text-muted-foreground">{fmtWhen(r.createdAt)} · {fmtWhen(r.settledAt)}</Td>
              </Tr>))}</TBody>
          </TableFrame>{loadMore('rounds')}</>)}
      </SectionBox>

      <SectionBox title="Attendee billing claims (registration ids only)" section={list<ClaimRow>('claims')} empty={p => p.items.length === 0}>
        {p => (<>
          <TableFrame minWidth="min-w-[720px]">
            <THead><Th>Registration id</Th><Th>Type</Th><Th>Job · round</Th><Th>Asset</Th><Th>Claimed</Th></THead>
            <TBody>{p.items.map(c => (
              <Tr key={c.claimId}>
                <Td className="font-mono text-[11.5px]">{c.registrationId ?? '—'}</Td>
                <Td><StatusPill tone={c.mode === 'units' ? 'accent' : 'info'}>{c.mode ?? '—'}</StatusPill></Td>
                <Td className="font-mono text-[11px]">{c.jobId ?? '—'}{c.round !== null ? ` · ${c.round}` : ''}</Td>
                <Td className="text-[12px]">{c.assetType ?? '—'}</Td>
                <Td className="text-[12px] text-muted-foreground">{fmtWhen(c.claimedAt)}</Td>
              </Tr>))}</TBody>
          </TableFrame>{loadMore('claims')}</>)}
      </SectionBox>

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionBox title="Usage records (badge units taken by rounds)" section={list<UsageRow>('usage')} empty={p => p.items.length === 0}>
          {p => (<>
            <TableFrame>
              <THead><Th>Unit key</Th><Th>Round</Th><Th align="right">Units</Th><Th align="right">Released</Th><Th>Created</Th></THead>
              <TBody>{p.items.length === 0 ? <TableStateRow colSpan={5}>None.</TableStateRow> : p.items.map(u => {
                // An open round's units are RESERVED, not kept; released units exist only after settlement.
                const s = usageState(u.roundStatus)
                return (
                  <Tr key={u.unitKey}><Td className="font-mono text-[11px]">{u.unitKey}</Td><Td><StatusPill tone={s.tone}>{s.label}</StatusPill></Td>
                    <Td align="right" className="tabular-nums">{qty(u.quantity)}</Td><Td align="right" className="tabular-nums">{s.settled ? qty(u.releasedUnits) : '—'}</Td><Td className="text-[12px] text-muted-foreground">{fmtWhen(u.createdAt)}</Td></Tr>
                )
              })}</TBody>
            </TableFrame>{loadMore('usage')}</>)}
        </SectionBox>
        <SectionBox title="Print jobs" section={list<JobRow>('jobs')} empty={p => p.items.length === 0}>
          {p => (<>
            <TableFrame>
              <THead><Th>Job</Th><Th>Status</Th><Th>Billing</Th><Th align="right">Done / total</Th></THead>
              <TBody>{p.items.map(j => (
                <Tr key={j.jobId}><Td className="font-mono text-[11px]">{j.jobId}</Td><Td className="text-[12px]">{j.status ?? '—'}</Td>
                  <Td className="text-[12px]">{j.billing ? `${j.billing.mode}${j.billing.mode === 'paid' ? ` · round ${j.billing.round}` : ''}` : 'free'}</Td>
                  <Td align="right" className="tabular-nums">{qty(j.counts.succeeded)} / {qty(j.counts.total)}</Td></Tr>))}</TBody>
            </TableFrame>{loadMore('jobs')}</>)}
        </SectionBox>
      </div>
      <p className="text-[11px] text-muted-foreground">Each load of this billing view is recorded in the admin audit log.</p>
    </div>
  )
}
