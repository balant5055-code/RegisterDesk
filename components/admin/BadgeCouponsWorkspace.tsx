'use client'

// RD-PRINT-BILL-P3 — Super Admin · ID-badge PURCHASE coupons (License Center → Badge coupons).
//
// Clearly separate from licence coupons: its own API (/api/admin/badge-coupons), its own collection,
// never accepted at licence checkout. Badge purchases are not released yet, so coupons here can be
// prepared, edited and PREVIEWED, but none is redeemed until purchases go live (Phase 4).
// Every change needs a reason (3–500 characters, counted before submission) and is audited; the
// server re-validates everything. Responsive: cards below `md`, a table from `md` up.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2, PlusCircle, PauseCircle, PlayCircle, Archive, Copy, PencilLine, IdCard, Lock, Eye, AlertCircle, CheckCircle2,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import { StatusPill, ErrorBanner, SearchInput, FilterTabs } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { parseRupeesToPaise, paiseToRupeesInput } from '@/lib/licensing/moneyInput'
import { badgeReasonProblem, BADGE_REASON_MAX } from '@/lib/licensing/printBadgeSettings'
import type { BadgeCouponRow, BadgeCouponLifecycle, BadgeCouponType, BadgeCouponValidation } from '@/lib/licensing/badgeCoupons/types'

const API = '/api/admin/badge-coupons'
const inputCls = 'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15'
const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60'
const btnPrimary = 'inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60'
const TONE: Record<BadgeCouponLifecycle, PillTone> = { draft: 'neutral', scheduled: 'info', active: 'success', paused: 'warning', expired: 'neutral', archived: 'neutral', invalid: 'danger' }
const FILTERS = [
  { value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'draft', label: 'Draft' }, { value: 'scheduled', label: 'Scheduled' },
  { value: 'paused', label: 'Paused' }, { value: 'expired', label: 'Expired' }, { value: 'archived', label: 'Archived' },
  // RD-PRINT-BILL-P3.2 — a stored date or restriction is corrupt; never applied until corrected.
  { value: 'invalid', label: 'Invalid' },
]

async function authHeader(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken()
  return { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' }
}
async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, { method: init?.method ?? 'GET', headers: await authHeader(), cache: 'no-store', ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) })
  const body = await res.json().catch(() => ({})) as T & { error?: string; details?: string[] }
  if (!res.ok) {
    const details = Array.isArray(body.details) && body.details.length > 1 ? body.details : null
    throw new Error(details ? details.join(' ') : (body.error ?? `Request failed (${res.status})`))
  }
  return body
}

const discountText = (c: Pick<BadgeCouponRow, 'type' | 'value' | 'maxDiscountPaise'>) =>
  c.type === 'percentage' ? `${c.value}% off${c.maxDiscountPaise != null ? ` (max ${formatPaise(c.maxDiscountPaise)})` : ''}`
    : c.type === 'fixed' ? `${formatPaise(c.value)} off` : 'Free (100%)'
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null)
const validityText = (c: BadgeCouponRow) => `${fmtDate(c.activatesAt) ?? 'Immediately'} → ${fmtDate(c.expiresAt) ?? 'No expiry'}`
const eligibilityText = (c: BadgeCouponRow) => {
  const ev = c.restrictions.eventIds.length, org = c.restrictions.organizerUids.length
  return `${ev ? `${ev} event${ev === 1 ? '' : 's'}` : 'All events'} · ${org ? `${org} organizer${org === 1 ? '' : 's'}` : 'All organizers'}`
}
const usesText = (c: BadgeCouponRow) => `${c.currentUses.toLocaleString('en-IN')}${c.usageLimit != null ? ` / ${c.usageLimit.toLocaleString('en-IN')}` : ''}`

/** Reason input with the rule stated up front and a live count (the server enforces it too). */
function ReasonInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const problem = value.trim() ? badgeReasonProblem(value) : null
  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="text-[11.5px] text-muted-foreground">Reason — required, 3–{BADGE_REASON_MAX} characters, recorded in the audit log</span>
      <textarea id={id} value={value} onChange={e => onChange(e.target.value)} maxLength={BADGE_REASON_MAX} rows={2}
        aria-describedby={`${id}-count`} className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" />
      <span id={`${id}-count`} className={cn('text-[11px] tabular-nums', problem ? 'text-destructive' : 'text-muted-foreground')}>
        {value.trim().length}/{BADGE_REASON_MAX} characters{problem ? ` — ${problem}` : ''}
      </span>
    </label>
  )
}

export function BadgeCouponsWorkspace() {
  const [coupons, setCoupons] = useState<BadgeCouponRow[] | null>(null)
  const [allowFree, setAllowFree] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lifecycle, setLifecycle] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState<BadgeCouponRow | 'new' | null>(null)
  const [action, setAction] = useState<{ coupon: BadgeCouponRow; kind: 'pause' | 'resume' | 'archive' | 'clone' } | null>(null)
  const [preview, setPreview] = useState<BadgeCouponRow | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await api<{ coupons: BadgeCouponRow[]; policy: { allowFreeCoupons: boolean } }>(`${API}?includeArchived=true`)
        if (alive) { setErr(null); setCoupons(d.coupons); setAllowFree(d.policy.allowFreeCoupons) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load badge coupons') }
    })()
    return () => { alive = false }
  }, [reloadKey])
  const reload = useCallback((msg?: string) => { setReloadKey(k => k + 1); if (msg) setNotice(msg) }, [])

  const filtered = useMemo(() => (coupons ?? []).filter(c => {
    if (lifecycle && c.lifecycle !== lifecycle) return false
    const q = search.trim().toLowerCase()
    return !q || c.code.toLowerCase().includes(q) || c.campaign.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  }), [coupons, lifecycle, search])

  const actions = (c: BadgeCouponRow) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <IconBtn title="Preview" onClick={() => setPreview(c)}><Eye className="size-3.5" /></IconBtn>
      {!c.archived && <IconBtn title="Edit" onClick={() => setEditing(c)}><PencilLine className="size-3.5" /></IconBtn>}
      <IconBtn title="Clone" onClick={() => setAction({ coupon: c, kind: 'clone' })}><Copy className="size-3.5" /></IconBtn>
      {!c.archived && (c.paused
        ? <IconBtn title="Resume" onClick={() => setAction({ coupon: c, kind: 'resume' })}><PlayCircle className="size-3.5" /></IconBtn>
        : <IconBtn title="Pause" onClick={() => setAction({ coupon: c, kind: 'pause' })}><PauseCircle className="size-3.5" /></IconBtn>)}
      {!c.archived && <IconBtn title="Archive" onClick={() => setAction({ coupon: c, kind: 'archive' })}><Archive className="size-3.5" /></IconBtn>}
    </div>
  )

  return (
    <div className="space-y-4" data-testid="badge-coupons-workspace">
      <div className="rounded-2xl border border-primary/15 bg-primary/[0.03] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/[0.09] text-primary"><IdCard className="size-4" aria-hidden /></span>
          <h2 className="text-[14px] font-semibold text-foreground">ID badge purchase coupons</h2>
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"><Lock className="size-3" aria-hidden /> Badge purchases not released</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', allowFree ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground')} data-testid="free-coupon-policy">
            Free (100%) coupons: {allowFree ? 'allowed' : 'not allowed'}
          </span>
        </div>
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Discounts on prepaid ID-badge unit purchases only — <span className="font-medium text-foreground">separate from licence coupons</span> and never accepted at
          licence checkout. One coupon per purchase. Coupons can be prepared and previewed now; none is redeemed until badge purchases are released.
          Codes are unique across licence and badge coupons.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search code, campaign, description…" className="w-full max-w-xs flex-1" aria-label="Search badge coupons" />
        <FilterTabs options={FILTERS} value={lifecycle} onChange={setLifecycle} aria-label="Filter by status" scrollable />
        <button type="button" onClick={() => { setNotice(null); setEditing('new') }} className={cn(btnPrimary, 'ml-auto')}><PlusCircle className="size-3.5" /> New badge coupon</button>
      </div>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      {notice && <p role="status" className="flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-700" data-testid="badge-coupon-notice"><CheckCircle2 className="size-3.5" aria-hidden />{notice}</p>}

      {coupons === null ? <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        : filtered.length === 0 ? <p className="rounded-xl border border-dashed border-border py-10 text-center text-[13px] text-muted-foreground">No badge coupons{lifecycle || search ? ' match these filters' : ' yet'}.</p>
        : (<>
          {/* md+ : table */}
          <div className="hidden overflow-x-auto rounded-2xl border border-border bg-card md:block">
            <table className="w-full text-[13px]">
              <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">Code</th><th className="px-4 py-2 font-semibold">Discount</th>
                  <th className="px-4 py-2 font-semibold">Status</th><th className="px-4 py-2 text-right font-semibold">Uses</th>
                  <th className="px-4 py-2 font-semibold">Validity</th><th className="px-4 py-2 font-semibold">Eligibility</th>
                  <th className="px-4 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.code} className="border-b border-border/60 align-top" data-testid={`badge-coupon-row-${c.code}`}>
                    <td className="px-4 py-2.5"><span className="font-mono font-semibold text-foreground">{c.code}</span><div className="max-w-[200px] truncate text-[11.5px] text-muted-foreground">{c.description || '—'}</div></td>
                    <td className="px-4 py-2.5">{discountText(c)}{c.minPurchasePaise != null && <div className="text-[11.5px] text-muted-foreground">Min {formatPaise(c.minPurchasePaise)}</div>}</td>
                    <td className="px-4 py-2.5"><StatusPill tone={TONE[c.lifecycle]}>{c.lifecycle}</StatusPill></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{usesText(c)}{c.perOrganizerLimit != null && <div className="text-[11.5px] text-muted-foreground">{c.perOrganizerLimit}/organizer</div>}</td>
                    <td className="px-4 py-2.5 text-[12px] text-muted-foreground">{validityText(c)}</td>
                    <td className="px-4 py-2.5 text-[12px] text-muted-foreground">{eligibilityText(c)}</td>
                    <td className="px-4 py-2.5">{actions(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* below md : cards */}
          <div className="space-y-2 md:hidden">
            {filtered.map(c => (
              <div key={c.code} className="rounded-xl border border-border bg-card p-3 text-[12.5px]" data-testid={`badge-coupon-card-${c.code}`}>
                <div className="flex items-center justify-between gap-2"><span className="font-mono font-semibold">{c.code}</span><StatusPill tone={TONE[c.lifecycle]}>{c.lifecycle}</StatusPill></div>
                <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
                  <dt className="text-muted-foreground">Discount</dt><dd>{discountText(c)}{c.minPurchasePaise != null ? ` · min ${formatPaise(c.minPurchasePaise)}` : ''}</dd>
                  <dt className="text-muted-foreground">Uses</dt><dd className="tabular-nums">{usesText(c)}{c.perOrganizerLimit != null ? ` · ${c.perOrganizerLimit}/organizer` : ''}</dd>
                  <dt className="text-muted-foreground">Validity</dt><dd>{validityText(c)}</dd>
                  <dt className="text-muted-foreground">Eligibility</dt><dd>{eligibilityText(c)}</dd>
                </dl>
                <div className="mt-2">{actions(c)}</div>
              </div>
            ))}
          </div>
        </>)}

      {editing && <CouponFormDialog coupon={editing === 'new' ? null : editing} allowFree={allowFree} onClose={() => setEditing(null)}
        onSaved={msg => { setEditing(null); reload(msg) }} />}
      {action && <ActionDialog coupon={action.coupon} kind={action.kind} onClose={() => setAction(null)} onDone={msg => { setAction(null); reload(msg) }} />}
      {preview && <PreviewDialog coupon={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">{children}</button>
}

const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (v: string): string | null => (v.trim() ? new Date(v).toISOString() : null)
const ids = (v: string) => [...new Set(v.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))]

function CouponFormDialog({ coupon, allowFree, onClose, onSaved }: {
  coupon: BadgeCouponRow | null; allowFree: boolean; onClose: () => void; onSaved: (msg: string) => void
}) {
  const isNew = coupon === null
  const redeemed = (coupon?.currentUses ?? 0) > 0
  const [code, setCode] = useState('')
  const [description, setDescription] = useState(coupon?.description ?? '')
  const [type, setType] = useState<BadgeCouponType>(coupon?.type ?? 'percentage')
  const [pct, setPct] = useState(coupon?.type === 'percentage' ? String(coupon.value) : '')
  const [fixed, setFixed] = useState(coupon?.type === 'fixed' ? paiseToRupeesInput(coupon.value) : '')
  const [cap, setCap] = useState(coupon?.maxDiscountPaise != null ? paiseToRupeesInput(coupon.maxDiscountPaise) : '')
  const [minP, setMinP] = useState(coupon?.minPurchasePaise != null ? paiseToRupeesInput(coupon.minPurchasePaise) : '')
  const [starts, setStarts] = useState(toLocalInput(coupon?.activatesAt ?? null))
  const [expires, setExpires] = useState(toLocalInput(coupon?.expiresAt ?? null))
  const [usage, setUsage] = useState(coupon?.usageLimit != null ? String(coupon.usageLimit) : '')
  const [perOrg, setPerOrg] = useState(coupon?.perOrganizerLimit != null ? String(coupon.perOrganizerLimit) : '')
  const [eventIds, setEventIds] = useState((coupon?.restrictions.eventIds ?? []).join(', '))
  const [orgIds, setOrgIds] = useState((coupon?.restrictions.organizerUids ?? []).join(', '))
  const [enabled, setEnabled] = useState(coupon?.enabled ?? false)
  const [campaign, setCampaign] = useState(coupon?.campaign ?? '')
  const [notes, setNotes] = useState(coupon?.internalNotes ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const money = (v: string, label: string): number | null | 'bad' => {
    if (!v.trim()) return null
    const r = parseRupeesToPaise(v)
    if (!r.ok || r.paise === null) { setError(`${label} is not a valid amount.`); return 'bad' }
    return r.paise
  }
  const wholeOrNull = (v: string): number | null => (v.trim() ? Number(v) : null)

  const submit = async () => {
    setError(null)
    const reasonProblem = badgeReasonProblem(reason)
    if (reasonProblem) { setError(reasonProblem); return }
    const capP = money(cap, 'The maximum discount'), minPP = money(minP, 'The minimum purchase'), fixedP = money(fixed, 'The fixed discount')
    if (capP === 'bad' || minPP === 'bad' || fixedP === 'bad') return
    const value = type === 'percentage' ? Number(pct) : type === 'fixed' ? fixedP : 0
    const body: Record<string, unknown> = {
      description, type, value, maxDiscountPaise: type === 'percentage' ? capP : null, minPurchasePaise: minPP,
      activatesAt: fromLocalInput(starts), expiresAt: fromLocalInput(expires),
      usageLimit: wholeOrNull(usage), perOrganizerLimit: wholeOrNull(perOrg),
      eventIds: ids(eventIds), organizerUids: ids(orgIds), enabled, campaign, internalNotes: notes,
    }
    if (!isNew && redeemed) { delete body.type; delete body.value }          // frozen after redemption
    setSaving(true)
    try {
      if (isNew) {
        await api(API, { method: 'POST', body: { reason: reason.trim(), coupon: { code, ...body } } })
        onSaved(`Badge coupon ${code.trim().toUpperCase()} created.`)
      } else {
        await api(`${API}/${encodeURIComponent(coupon!.code)}`, { method: 'POST', body: { action: 'update', reason: reason.trim(), coupon: body } })
        onSaved(`Badge coupon ${coupon!.code} updated.`)
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'The coupon could not be saved.') }
    finally { setSaving(false) }
  }

  const freeChoice = type === 'free' || (type === 'percentage' && Number(pct) >= 100 && !cap.trim())
  return (
    <Dialog open onClose={onClose} title={isNew ? 'New ID badge coupon' : `Edit ${coupon!.code}`} size="lg" footer={
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className={btn} disabled={saving}>Cancel</button>
        <button type="button" onClick={() => void submit()} className={btnPrimary} disabled={saving || !!badgeReasonProblem(reason)} data-testid="badge-coupon-save">
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />} {isNew ? 'Create coupon' : 'Save changes'}
        </button>
      </div>
    }>
      <div className="space-y-3 text-[13px]" data-testid="badge-coupon-form">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isNew && <Field label="Code (3–40: A–Z, 0–9, _ or -)"><input value={code} onChange={e => setCode(e.target.value.toUpperCase())} className={cn(inputCls, 'font-mono')} placeholder="BADGES20" /></Field>}
          <Field label="Description (shown to organizers later)"><input value={description} onChange={e => setDescription(e.target.value)} maxLength={200} className={inputCls} /></Field>
          <Field label="Discount type">
            <select value={type} onChange={e => setType(e.target.value as BadgeCouponType)} disabled={redeemed} className={inputCls}>
              <option value="percentage">Percentage</option><option value="fixed">Fixed amount</option>
              <option value="free" disabled={!allowFree && coupon?.type !== 'free'}>Free (100%){!allowFree ? ' — not allowed' : ''}</option>
            </select>
          </Field>
          {type === 'percentage' && <Field label="Percent off (1–100)"><input type="number" min={1} max={100} value={pct} onChange={e => setPct(e.target.value)} disabled={redeemed} className={inputCls} /></Field>}
          {type === 'fixed' && <Field label="Amount off (₹, incl. GST)"><input inputMode="decimal" value={fixed} onChange={e => setFixed(e.target.value)} disabled={redeemed} className={inputCls} /></Field>}
          {type === 'percentage' && <Field label="Maximum discount (₹; blank = no cap)"><input inputMode="decimal" value={cap} onChange={e => setCap(e.target.value)} className={inputCls} /></Field>}
          <Field label="Minimum purchase (₹; blank = none)"><input inputMode="decimal" value={minP} onChange={e => setMinP(e.target.value)} className={inputCls} /></Field>
          <Field label="Starts (blank = immediately)"><input type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)} className={inputCls} /></Field>
          <Field label="Expires (blank = never)"><input type="datetime-local" value={expires} onChange={e => setExpires(e.target.value)} className={inputCls} /></Field>
          <Field label="Total uses (blank = unlimited)"><input type="number" min={1} value={usage} onChange={e => setUsage(e.target.value)} className={inputCls} /></Field>
          <Field label="Uses per organizer (blank = unlimited)"><input type="number" min={1} value={perOrg} onChange={e => setPerOrg(e.target.value)} className={inputCls} /></Field>
          <Field label="Only these events (event ids; blank = all)"><input value={eventIds} onChange={e => setEventIds(e.target.value)} className={inputCls} placeholder="city-marathon-2026, …" /></Field>
          <Field label="Only these organizers (uids; blank = all)"><input value={orgIds} onChange={e => setOrgIds(e.target.value)} className={inputCls} /></Field>
          <Field label="Campaign tag"><input value={campaign} onChange={e => setCampaign(e.target.value)} maxLength={60} className={inputCls} /></Field>
          <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled (otherwise a draft)</label>
        </div>
        <Field label="Internal notes (Super Admins only)"><textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={1000} rows={2} className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        {redeemed && <p className="rounded-lg bg-muted px-2.5 py-1.5 text-[12px] text-muted-foreground">This coupon has been redeemed {coupon!.currentUses} time{coupon!.currentUses === 1 ? '' : 's'}, so its discount type and value are locked. Clone it to offer a different discount.</p>}
        {freeChoice && <p className={cn('rounded-lg px-2.5 py-1.5 text-[12px]', allowFree ? 'bg-amber-50 text-amber-900' : 'bg-destructive/5 text-destructive')}>
          {allowFree ? 'This coupon makes a purchase free. It is audited as a free coupon.' : 'Free (100%) badge coupons are not allowed. Enable them in Business Configuration first.'}</p>}
        <ReasonInput id="badge-coupon-reason" value={reason} onChange={setReason} />
        {error && <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-destructive" data-testid="badge-coupon-error"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{error}</p>}
      </div>
    </Dialog>
  )
}

function ActionDialog({ coupon, kind, onClose, onDone }: { coupon: BadgeCouponRow; kind: 'pause' | 'resume' | 'archive' | 'clone'; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = { pause: `Pause ${coupon.code}?`, resume: `Resume ${coupon.code}?`, archive: `Archive ${coupon.code}?`, clone: `Clone ${coupon.code}` }[kind]
  const text = {
    pause: 'A paused coupon cannot be applied until it is resumed.',
    resume: 'The coupon can be applied again, within its dates and limits.',
    archive: 'Archiving is permanent: the coupon can never be applied again and cannot be edited or resumed. Its record and history are kept. Clone it to reuse its settings.',
    clone: 'Creates a new DRAFT coupon with the same settings and no usage.',
  }[kind]
  const go = async () => {
    const p = badgeReasonProblem(reason)
    if (p) { setError(p); return }
    setBusy(true); setError(null)
    try {
      await api(`${API}/${encodeURIComponent(coupon.code)}`, { method: 'POST', body: { action: kind, reason: reason.trim(), ...(kind === 'clone' ? { newCode } : {}) } })
      onDone(kind === 'clone' ? `Cloned as ${newCode.trim().toUpperCase()} (draft).` : `${coupon.code} ${kind === 'pause' ? 'paused' : kind === 'resume' ? 'resumed' : 'archived'}.`)
    } catch (e) { setError(e instanceof Error ? e.message : 'The action failed.') }
    finally { setBusy(false) }
  }
  return (
    <Dialog open onClose={onClose} title={title} size="sm" footer={
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={btn} disabled={busy}>Cancel</button>
        <button type="button" onClick={() => void go()} disabled={busy || !!badgeReasonProblem(reason) || (kind === 'clone' && !newCode.trim())}
          className={kind === 'archive' ? 'inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-[12.5px] font-semibold text-destructive-foreground disabled:opacity-60' : btnPrimary}
          data-testid="badge-coupon-action-confirm">
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} {kind === 'archive' ? 'Archive permanently' : kind === 'clone' ? 'Clone' : kind === 'pause' ? 'Pause' : 'Resume'}
        </button>
      </div>
    }>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted-foreground">{text}</p>
        {kind === 'clone' && <Field label="New code"><input value={newCode} onChange={e => setNewCode(e.target.value.toUpperCase())} className={cn(inputCls, 'font-mono')} /></Field>}
        <ReasonInput id="badge-coupon-action-reason" value={reason} onChange={setReason} />
        {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
      </div>
    </Dialog>
  )
}

function PreviewDialog({ coupon, onClose }: { coupon: BadgeCouponRow; onClose: () => void }) {
  const [organizerUid, setOrganizerUid] = useState('')
  const [eventId, setEventId] = useState('')
  const [amount, setAmount] = useState('20.00')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BadgeCouponValidation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setError(null); setResult(null)
    const r = parseRupeesToPaise(amount)
    if (!r.ok || r.paise === null || r.paise < 1) { setError('Enter a purchase amount.'); return }
    setBusy(true)
    try {
      const d = await api<{ preview: BadgeCouponValidation }>(`${API}/${encodeURIComponent(coupon.code)}`, { method: 'POST', body: { action: 'preview', organizerUid: organizerUid.trim(), eventId: eventId.trim(), purchasePaise: r.paise } })
      setResult(d.preview)
    } catch (e) { setError(e instanceof Error ? e.message : 'Preview failed') }
    finally { setBusy(false) }
  }
  return (
    <Dialog open onClose={onClose} title={`Preview ${coupon.code}`} size="md" footer={
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={btn}>Close</button>
        <button type="button" onClick={() => void run()} className={btnPrimary} disabled={busy} data-testid="badge-coupon-preview-run">{busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Preview</button></div>
    }>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted-foreground">Shows what this coupon would do, checked exactly as a purchase will. A preview never uses up the coupon.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Organizer uid"><input value={organizerUid} onChange={e => setOrganizerUid(e.target.value)} className={inputCls} /></Field>
          <Field label="Event id"><input value={eventId} onChange={e => setEventId(e.target.value)} className={inputCls} /></Field>
          <Field label="Purchase (₹, incl. GST)"><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className={inputCls} /></Field>
        </div>
        {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
        {result && (result.ok
          ? <div className="rounded-lg bg-emerald-50 p-2.5 text-[12.5px] text-emerald-900" data-testid="badge-coupon-preview-result">
              Valid · discount <span className="font-semibold">{formatPaise(result.discountPaise)}</span> · payable <span className="font-semibold">{formatPaise(result.finalPricePaise)}</span>{result.free ? ' (free)' : ''}
            </div>
          : <div className="rounded-lg bg-destructive/5 p-2.5 text-[12.5px] text-destructive" data-testid="badge-coupon-preview-result">Not valid · {result.message}</div>)}
      </div>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[11.5px] text-muted-foreground">{label}</span>{children}</label>
}
