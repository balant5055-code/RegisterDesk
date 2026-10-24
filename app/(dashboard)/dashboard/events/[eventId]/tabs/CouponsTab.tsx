'use client'

// RD-EVENT-14 · Coupons — the codes this event honours, and whether they still work.
//
// ═══ WHAT THIS WORKSPACE ANSWERS ═════════════════════════════════════════════
// Which codes exist · which of them an attendee could redeem RIGHT NOW · what each one
// takes off · who it applies to · how much of its limit is spent · why one has stopped
// working. It is a workspace inside the Event Command Center, not a CRUD table: the
// shell header above owns the event's identity and none of it is repeated here.
//
// ═══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
// The previous version rendered `coupon.active ? 'Active' : 'Inactive'`. `active` is ONE
// of the four gates `lib/coupons/validate.ts` applies, so an expired code, a scheduled
// one and a spent one all wore a green "Active" pill while every attendee typing them was
// refused. This is the same defect RD-DASH-07 found on the dashboard — where a card
// claimed sixteen active coupons on a day the validator would have refused all sixteen —
// and `lib/coupons/couponState.ts` was written then to be the single answer. This surface
// now uses it, so the badge and the enforcement cannot disagree.
//
// Two further things the old surface got wrong, both fixed here:
//   · `currentUses` was printed raw. A legacy document without the counter rendered a
//     blank "Used" and "NaN left". Usage is now `number | null` and an unknown count is a
//     dash that says Unavailable, never a zero.
//   · Toggle and delete swallowed their failures (`catch { /* non-critical */ }`) and then
//     updated local state anyway, so a refused request looked like a success and the
//     coupon stayed live. Nothing here changes on screen until the server has agreed.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
// ONE bounded GET per mount, capped server-side at COUPON_DOC_BUDGET documents, plus one
// request per mutation. Filtering and search are in-memory ON PURPOSE: the whole (bounded)
// set is present, and the API says so when it had to truncate — unlike a paged list, where
// filtering the page in the browser silently hides the rest.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  AlertTriangle, ArrowRight, BadgePercent, CalendarClock, Check, CheckCircle2, CircleSlash,
  Clock, Info, Loader2, Pencil, Plus, Power, RefreshCw, Search, Tag, Ticket, Trash2,
  TrendingUp, X,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { couponToday } from '@/lib/coupons/couponState'
import { validateCouponInput, couponValueRule, MAX_DESCRIPTION, type CouponInput } from '@/lib/coupons/couponInput'
import {
  COUPON_FILTERS, COUPON_STATE_LABEL, COUPON_STATE_TONE, UNAVAILABLE, couponEmptyMessage,
  couponScope, couponStateNote, couponStateOf, couponUsage,
  couponUsageLabel, couponWindowLabel, couponsSummary, filterCoupons, formatCouponValue,
  sortCoupons, type CouponFilter, type CouponRow, type CouponState,
} from '@/lib/coupons/couponView'
import { passNoun } from '@/lib/passes/passView'
import type { CouponType } from '@/lib/coupons/types'
import type { CouponsListResponse } from '@/app/api/organizer/events/[eventId]/coupons/route'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

// ─── Status vocabulary ────────────────────────────────────────────────────────

/**
 * Every state carries THREE signals — icon, word, tone. Colour is the last of them and
 * never the only one, so the surface still reads correctly in greyscale.
 */
const STATE_ICON: Record<CouponState, typeof Check> = {
  redeemable: CheckCircle2,
  exhausted:  CircleSlash,
  expired:    Clock,
  scheduled:  CalendarClock,
  inactive:   Power,
}

function StatusBadge({ state }: { state: CouponState }) {
  const Icon = STATE_ICON[state]
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold',
      accent(COUPON_STATE_TONE[state]).tile,
    )}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {COUPON_STATE_LABEL[state]}
    </span>
  )
}

/** A hairline meter. `percent === null` means there is no proportion to draw. */
function Meter({ percent, tone, label }: { percent: number | null; tone: AccentTone; label: string }) {
  if (percent === null) {
    // A dashed rail, so "we cannot draw this" is visibly different from "nothing yet".
    return <div className="h-1.5 w-full rounded-pill border border-dashed border-border" aria-hidden />
  }
  const width = Math.min(100, Math.max(percent, percent > 0 ? 2 : 0))
  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
    >
      <div className={cn('h-full rounded-pill transition-[width] duration-500', accent(tone).bar)}
           style={{ width: `${width}%` }} />
    </div>
  )
}

const usageTone = (pct: number): AccentTone =>
  pct >= 100 ? 'critical' : pct >= 80 ? 'pending' : 'verify'

function OverviewMetric({ icon: Icon, tone, value, label, sub, unavailable }: {
  icon: typeof Ticket
  tone: AccentTone
  value: string
  label: string
  sub?: string | null
  unavailable?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        {/* A WORD is set smaller than a numeral — the same rule the Passes overview
            follows. A long word at numeral size reads as the most important figure on
            the row, which is the opposite of true. */}
        <p className={cn(
          'font-semibold leading-none',
          /^[\d,]+$/.test(value) ? 'text-fs-xl tabular-nums' : 'text-fs-md',
          unavailable ? 'text-muted-foreground' : 'text-foreground',
        )}>
          {unavailable
            ? <><span aria-hidden>{value}</span><span className="sr-only">Unavailable</span></>
            : value}
        </p>
        <p className="mt-1.5 truncate text-fs-xs font-medium text-foreground">{label}</p>
        {sub && <p className="truncate text-fs-2xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Shared control classes ───────────────────────────────────────────────────

const FIELD =
  'w-full rounded-control border border-border bg-background px-3 py-2 text-fs-sm text-foreground ' +
  'placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const GHOST_BTN =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 ' +
  'text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control bg-primary/[0.08] px-4 ' +
  'text-fs-sm font-semibold text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14] ' +
  'disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

// ─── Form ─────────────────────────────────────────────────────────────────────

interface FormState {
  code:        string
  description: string
  type:        CouponType
  /** Percentage as a whole number; fixed as RUPEES (converted to paise on submit). */
  value:       string
  active:      boolean
  validFrom:   string
  validUntil:  string
  maxUses:     string
  applicablePassIds: string[]
}

const BLANK: FormState = {
  code: '', description: '', type: 'percentage', value: '',
  active: true, validFrom: '', validUntil: '', maxUses: '', applicablePassIds: [],
}

/**
 * The form's fields as the SERVER's shape.
 *
 * Fixed amounts are entered in rupees and stored in paise — one conversion, in one place,
 * so the editor and the create form cannot round differently.
 */
function toInput(f: FormState): Partial<CouponInput> {
  const raw = f.value.trim()
  const value =
    f.type === 'free'  ? 100
    : f.type === 'fixed' ? (raw === '' ? NaN : Math.round(parseFloat(raw) * 100))
    : (raw === '' ? NaN : Number(raw))

  return {
    code:        f.code,
    description: f.description,
    type:        f.type,
    value,
    active:      f.active,
    validFrom:   f.validFrom  || null,
    validUntil:  f.validUntil || null,
    maxUses:     f.maxUses.trim() === '' ? null : Number(f.maxUses),
    applicablePassIds: f.applicablePassIds,
  }
}

function formFromRow(row: CouponRow): FormState {
  return {
    code:        row.code,
    description: row.description,
    type:        row.type,
    value:       row.type === 'fixed' ? String(row.value / 100)
               : row.type === 'free'  ? ''
               : String(row.value),
    active:      row.active,
    validFrom:   row.validFrom  ?? '',
    validUntil:  row.validUntil ?? '',
    maxUses:     row.maxUses != null ? String(row.maxUses) : '',
    applicablePassIds: row.applicablePassIds,
  }
}

function CouponForm({ initial, heading, onSave, onCancel, saving, serverError, passes, noun }: {
  initial:     FormState
  heading:     string
  onSave:      (input: CouponInput) => void
  onCancel:    () => void
  saving:      boolean
  serverError: string | null
  passes:      { id: string; name: string }[]
  noun:        { one: string; many: string }
}) {
  const [f, setF] = useState<FormState>(initial)
  const [localError, setLocalError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setF(p => ({ ...p, [k]: v }))

  const togglePass = (id: string) => setF(p => ({
    ...p,
    applicablePassIds: p.applicablePassIds.includes(id)
      ? p.applicablePassIds.filter(x => x !== id)
      : [...p.applicablePassIds, id],
  }))

  // The SAME validator the API runs, so the form never accepts something the server would
  // refuse and the two never word the same rule differently.
  const candidate = toInput(f)
  const parsed    = validateCouponInput(candidate, passes.map(p => p.id))
  const preview   = parsed.ok ? formatCouponValue(parsed.value) : null

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!parsed.ok) { setLocalError(parsed.error); return }
    setLocalError(null)
    onSave(parsed.value)
  }

  const labelCls = 'mb-1 block text-fs-xs font-medium text-foreground'
  const hintCls  = 'mt-1 text-fs-2xs text-muted-foreground'

  return (
    <form onSubmit={submit} className="rounded-surface border border-primary/25 bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="text-fs-sm font-semibold text-foreground">{heading}</h3>
        {preview && (
          <span className={cn('inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold', accent('money').tile)}>
            <BadgePercent className="size-3" aria-hidden />
            {preview}
          </span>
        )}
      </div>

      <div className="space-y-4 p-4">
        {/* ── Identity ─────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="coupon-code" className={labelCls}>Code</label>
            <input
              id="coupon-code"
              className={cn(FIELD, 'font-mono uppercase tracking-wide')}
              value={f.code}
              onChange={e => set('code', e.target.value.toUpperCase())}
              placeholder="EARLYBIRD20"
              maxLength={30}
              autoComplete="off"
              required
            />
            <p className={hintCls}>What an attendee types at checkout. Letters, digits, hyphens.</p>
          </div>

          <div className="min-w-0">
            <label htmlFor="coupon-type" className={labelCls}>Discount type</label>
            <select
              id="coupon-type"
              className={FIELD}
              value={f.type}
              onChange={e => set('type', e.target.value as CouponType)}
            >
              <option value="percentage">Percentage off</option>
              <option value="fixed">Fixed amount off</option>
              <option value="free">Free — full price</option>
            </select>
            <p className={hintCls}>{couponValueRule(f.type)}</p>
          </div>
        </div>

        <div className="min-w-0">
          <label htmlFor="coupon-desc" className={labelCls}>Description</label>
          <input
            id="coupon-desc"
            className={FIELD}
            value={f.description}
            onChange={e => set('description', e.target.value)}
            placeholder="Early-bird discount for the first week"
            maxLength={MAX_DESCRIPTION}
            required
          />
          <p className={hintCls}>Internal — so your team knows what this code is for.</p>
        </div>

        {/* ── Amount ───────────────────────────────────────────────────── */}
        {f.type !== 'free' && (
          <div className="min-w-0 sm:max-w-xs">
            <label htmlFor="coupon-value" className={labelCls}>
              {f.type === 'percentage' ? 'Percentage off' : 'Amount off'}
            </label>
            <div className="relative">
              {f.type === 'fixed' && (
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-fs-sm text-muted-foreground" aria-hidden>₹</span>
              )}
              <input
                id="coupon-value"
                className={cn(FIELD, 'tabular-nums', f.type === 'fixed' ? 'pl-7' : 'pr-8')}
                value={f.value}
                onChange={e => set('value', e.target.value)}
                inputMode="decimal"
                placeholder={f.type === 'percentage' ? '20' : '500'}
                required
              />
              {f.type === 'percentage' && (
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-fs-sm text-muted-foreground" aria-hidden>%</span>
              )}
            </div>
          </div>
        )}

        {/* ── Window ───────────────────────────────────────────────────── */}
        <fieldset className="min-w-0">
          <legend className={labelCls}>When it works</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="coupon-from" className="mb-1 block text-fs-2xs text-muted-foreground">Starts</label>
              <input id="coupon-from" type="date" className={FIELD}
                     value={f.validFrom} onChange={e => set('validFrom', e.target.value)} />
            </div>
            <div className="min-w-0">
              <label htmlFor="coupon-until" className="mb-1 block text-fs-2xs text-muted-foreground">Ends</label>
              <input id="coupon-until" type="date" className={FIELD}
                     value={f.validUntil} onChange={e => set('validUntil', e.target.value)} />
            </div>
          </div>
          <p className={hintCls}>Both inclusive. Leave blank for no date limit.</p>
        </fieldset>

        {/* ── Limit ────────────────────────────────────────────────────── */}
        <div className="min-w-0 sm:max-w-xs">
          <label htmlFor="coupon-max" className={labelCls}>Usage limit</label>
          <input
            id="coupon-max"
            className={cn(FIELD, 'tabular-nums')}
            value={f.maxUses}
            onChange={e => set('maxUses', e.target.value)}
            inputMode="numeric"
            placeholder="No limit"
          />
          <p className={hintCls}>Total redemptions allowed. Blank means unlimited.</p>
        </div>

        {/* ── Scope ────────────────────────────────────────────────────── */}
        {passes.length > 0 && (
          <fieldset className="min-w-0">
            <legend className={labelCls}>Which {noun.many} it applies to</legend>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => set('applicablePassIds', [])}
                aria-pressed={f.applicablePassIds.length === 0}
                className={cn(
                  'inline-flex h-9 items-center rounded-pill border px-3 text-fs-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  f.applicablePassIds.length === 0
                    ? 'border-transparent bg-primary/[0.10] text-[color:var(--primary-text)]'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                All {noun.many}
              </button>
              {passes.map(p => {
                const on = f.applicablePassIds.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => togglePass(p.id)}
                    aria-pressed={on}
                    className={cn(
                      'inline-flex h-9 max-w-[14rem] items-center gap-1.5 rounded-pill border px-3 text-fs-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      on
                        ? 'border-transparent bg-primary/[0.10] text-[color:var(--primary-text)]'
                        : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {on && <Check className="size-3 shrink-0" aria-hidden />}
                    <span className="truncate">{p.name}</span>
                  </button>
                )
              })}
            </div>
            <p className={hintCls}>Select none to let the code work on every {noun.one}.</p>
          </fieldset>
        )}

        {/* ── Switch ───────────────────────────────────────────────────── */}
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            checked={f.active}
            onChange={e => set('active', e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-fs-xs font-medium text-foreground">Switched on</span>
            <span className="block text-fs-2xs text-muted-foreground">
              Off means nobody can redeem it, whatever its dates say.
            </span>
          </span>
        </label>
      </div>

      {(localError || serverError) && (
        <p role="alert" className="flex items-start gap-1.5 border-t border-border px-4 py-2.5 text-fs-xs text-critical">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          {localError ?? serverError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-4 py-3">
        <button type="submit" className={PRIMARY_BTN} disabled={saving}>
          {saving ? <><Loader2 className="size-4 animate-spin" aria-hidden />Saving…</> : 'Save coupon'}
        </button>
        <button type="button" onClick={onCancel} className={cn(GHOST_BTN, 'h-11')} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── One coupon ───────────────────────────────────────────────────────────────

function CouponModule({ row, today, passes, noun, busy, onEdit, onToggle, onDelete }: {
  row:      CouponRow
  today:    string
  passes:   { id: string; name: string }[]
  noun:     { one: string; many: string }
  busy:     boolean
  onEdit:   () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const state = couponStateOf(row, today)
  const usage = couponUsage(row)
  const note  = couponStateNote(row, state)
  const tone  = COUPON_STATE_TONE[state]
  const scope = couponScope(row.applicablePassIds, passes, noun)

  return (
    <li className={cn(
      'flex min-w-0 flex-col overflow-hidden rounded-surface border border-border bg-card',
      busy && 'opacity-60',
    )}>
      {/* A hairline of the state's own colour, so the card is identifiable before it is read. */}
      <span className={cn('h-0.5 w-full shrink-0', accent(tone).bar)} aria-hidden />

      <div className="flex items-start gap-3 p-4">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
          <Tag className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 break-all font-mono text-fs-md font-bold tracking-tight text-foreground">{row.code}</p>
            <StatusBadge state={state} />
          </div>
          <p className="mt-1 text-fs-xs leading-relaxed text-muted-foreground">{row.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            aria-label={row.active ? `Switch off ${row.code}` : `Switch on ${row.code}`}
            className={cn(
              'inline-flex size-9 items-center justify-center rounded-control text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              row.active && 'text-[color:var(--primary-text)]',
            )}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Power className="size-4" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            aria-label={`Edit ${row.code}`}
            className={cn(
              'inline-flex size-9 items-center justify-center rounded-control text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            <Pencil className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${row.code}`}
            className={cn(
              'inline-flex size-9 items-center justify-center rounded-control text-muted-foreground transition-colors',
              'hover:bg-critical/10 hover:text-critical disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* ── The three facts an organizer checks ─────────────────────────── */}
      <dl className="grid grid-cols-3 gap-px border-t border-border bg-border">
        <div className="min-w-0 bg-card px-3 py-2.5">
          <dt className="text-fs-2xs text-muted-foreground">Takes off</dt>
          <dd className={cn('mt-0.5 truncate text-fs-sm font-semibold', accent('money').fg)}>
            {formatCouponValue(row)}
          </dd>
        </div>
        <div className="min-w-0 bg-card px-3 py-2.5">
          <dt className="text-fs-2xs text-muted-foreground">Applies to</dt>
          <dd className={cn('mt-0.5 truncate text-fs-sm font-semibold',
            scope.broken ? 'text-critical' : 'text-foreground')}>
            {scope.label}
          </dd>
        </div>
        <div className="min-w-0 bg-card px-3 py-2.5">
          <dt className="text-fs-2xs text-muted-foreground">Window</dt>
          <dd className="mt-0.5 truncate text-fs-sm font-semibold text-foreground">
            {couponWindowLabel(row)}
          </dd>
        </div>
      </dl>

      {/* ── Usage ──────────────────────────────────────────────────────── */}
      <div className="mt-auto border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className={cn('text-fs-xs font-medium', usage.known ? 'text-foreground' : 'text-muted-foreground')}>
            {couponUsageLabel(usage)}
          </p>
          {usage.percent !== null && (
            <p className="text-fs-xs font-semibold tabular-nums text-foreground">{usage.percent}%</p>
          )}
        </div>

        {/* A rail is drawn only where a proportion exists, or where one exists but could
            not be read. An unlimited coupon has nothing to fill, and a full-width dashed
            rail under it would read as an untouched progress bar. */}
        {(usage.percent !== null || (usage.limit !== null && !usage.known)) && (
          <div className="mt-2">
            <Meter
              percent={usage.percent}
              tone={usage.percent === null ? 'neutral' : usageTone(usage.percent)}
              label={usage.percent === null
                ? `Usage of ${row.code} is unavailable`
                : `${row.code}: ${usage.percent}% of its limit used`}
            />
          </div>
        )}

        {usage.exceeded && (
          <p className="mt-1.5 flex items-start gap-1.5 text-fs-2xs text-critical">
            <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
            Redeemed more times than its current limit — the limit was lowered afterwards.
          </p>
        )}
        {!usage.known && (
          <p className="mt-1.5 text-fs-2xs text-muted-foreground">
            Redemptions couldn&apos;t be read for this coupon — unavailable, not zero.
          </p>
        )}
        {/* The status above is the validator's four gates; pass-applicability is a fifth
            check it makes per attempt. When every pass this code was restricted to has
            been deleted, that fifth check refuses EVERY attempt — so the card would
            otherwise say "Active" about a code nobody on earth can redeem. */}
        {scope.broken && (
          <p className="mt-1.5 flex items-start gap-1.5 text-fs-2xs text-critical">
            <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
            Restricted to {row.applicablePassIds.length === 1 ? `a ${noun.one}` : noun.many} that no
            longer {row.applicablePassIds.length === 1 ? 'exists' : 'exist'}, so nobody can
            redeem it. Edit it to choose one that does.
          </p>
        )}
        {!scope.broken && scope.missing > 0 && (
          <p className="mt-1.5 flex items-start gap-1.5 text-fs-2xs text-muted-foreground">
            <Info className="mt-px size-3 shrink-0" aria-hidden />
            {scope.missing} of the {noun.many} it was restricted to {scope.missing === 1 ? 'has' : 'have'} been removed.
          </p>
        )}
        {note && (
          <p className="mt-1.5 flex items-start gap-1.5 text-fs-2xs text-muted-foreground">
            <Info className="mt-px size-3 shrink-0" aria-hidden />
            {note}
          </p>
        )}
      </div>
    </li>
  )
}

// ─── Error reading ────────────────────────────────────────────────────────────

/**
 * The statuses this product's own coupon routes produce, all of which carry fixed,
 * human-readable copy. Anything else — a proxy error, a framework 500 with a digest — is
 * replaced with our own sentence rather than shown, because those messages describe
 * internals and are not for an organizer.
 */
const TRUSTED_STATUSES = new Set([400, 403, 404, 409, 503])

async function readError(res: Response, fallback: string): Promise<string> {
  if (!TRUSTED_STATUSES.has(res.status)) return fallback
  try {
    const json = await res.json() as { error?: string }
    return typeof json.error === 'string' && json.error ? json.error : fallback
  } catch {
    return fallback
  }
}

// ─── Workspace ────────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ready' | 'error'

export default function CouponsTab({ event, token }: { event: EventDetailResponse; token: string }) {
  const eventId = event.draftId
  const noun    = passNoun(event.eventType)
  const passes  = useMemo(
    () => event.passes.map(p => ({ id: p.id, name: p.name })),
    [event.passes],
  )

  const [coupons, setCoupons] = useState<CouponRow[]>([])
  const [state,   setState]   = useState<LoadState>('loading')
  const [today,   setToday]   = useState(() => couponToday(new Date()))
  const [published,      setPublished]      = useState(true)
  const [truncated,      setTruncated]      = useState(false)
  const [couponsEnabled, setCouponsEnabled] = useState(true)
  // RD-COUPON-SWITCH-01 — switched off for THIS event by RegisterDesk (Super Admin).
  const [couponsDisabledForEvent, setCouponsDisabledForEvent] = useState(false)

  const [adding,    setAdding]    = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [saveErr,   setSaveErr]   = useState<string | null>(null)
  const [busyId,    setBusyId]    = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const [filter, setFilter] = useState<CouponFilter>('all')
  const [query,  setQuery]  = useState('')

  const { confirm } = useConfirm()

  const base = `/api/organizer/events/${eventId}/coupons`
  const authHeaders = useMemo(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token],
  )

  // ── Load ──────────────────────────────────────────────────────────────────
  // Target-keyed rather than guarded by an effect-instance flag: under StrictMode the
  // first effect's cleanup would otherwise discard a response that had already arrived,
  // which is exactly the bug RD-EVENT-09 fixed in the shell.
  const [attempt, setAttempt] = useState(0)
  const loadKey = useRef('')

  useEffect(() => {
    if (!token) return
    const key = `${eventId}|${attempt}`
    if (loadKey.current === key) return
    loadKey.current = key

    void (async () => {
      setState('loading')
      setActionErr(null)
      try {
        const res = await fetch(base, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error('load')
        const json = await res.json() as CouponsListResponse
        if (loadKey.current !== key) return
        setCoupons(json.coupons ?? [])
        setToday(json.today ?? couponToday(new Date()))
        setPublished(json.eventPublished !== false)
        setTruncated(json.truncated === true)
        setCouponsEnabled(json.couponsEnabled !== false)
        setCouponsDisabledForEvent(json.couponsDisabledForEvent === true)
        setState('ready')
      } catch {
        if (loadKey.current !== key) return
        setState('error')
      }
    })()
  }, [base, token, eventId, attempt])

  const reload = useCallback(() => setAttempt(n => n + 1), [])

  // ── Mutations ─────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async (input: CouponInput) => {
    setSaving(true); setSaveErr(null)
    try {
      const res = await fetch(base, { method: 'POST', headers: authHeaders, body: JSON.stringify(input) })
      if (!res.ok) { setSaveErr(await readError(res, 'The coupon could not be saved. Please try again.')); return }
      const json = await res.json() as { coupon: CouponRow }
      setCoupons(prev => [json.coupon, ...prev])
      setAdding(false)
    } catch {
      setSaveErr('The coupon could not be saved. Please check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }, [base, authHeaders])

  const handleUpdate = useCallback(async (id: string, input: CouponInput) => {
    setSaving(true); setSaveErr(null)
    try {
      const res = await fetch(`${base}/${id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify(input) })
      if (!res.ok) { setSaveErr(await readError(res, 'The coupon could not be saved. Please try again.')); return }
      // The row is patched from the values the SERVER validated, not from the form — a
      // normalised code or a dropped date must show as stored, not as typed.
      setCoupons(prev => prev.map(c => c.id === id ? { ...c, ...input } : c))
      setEditingId(null)
    } catch {
      setSaveErr('The coupon could not be saved. Please check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }, [base, authHeaders])

  /**
   * Nothing changes on screen until the server has agreed.
   *
   * The old version updated local state inside the same statement that ignored the
   * response, so a refused toggle looked like a success while the coupon stayed live —
   * a control that lies about money.
   */
  const handleToggle = useCallback(async (row: CouponRow) => {
    const next = !row.active
    setBusyId(row.id); setActionErr(null)
    try {
      const res = await fetch(`${base}/${row.id}`, {
        method: 'PATCH', headers: authHeaders, body: JSON.stringify({ active: next }),
      })
      if (!res.ok) {
        setActionErr(await readError(res,
          `${row.code} could not be switched ${next ? 'on' : 'off'}. It is unchanged.`))
        return
      }
      setCoupons(prev => prev.map(c => c.id === row.id ? { ...c, active: next } : c))
    } catch {
      setActionErr(`${row.code} could not be switched ${next ? 'on' : 'off'}. It is unchanged.`)
    } finally {
      setBusyId(null)
    }
  }, [base, authHeaders])

  const handleDelete = useCallback(async (row: CouponRow) => {
    const usage = couponUsage(row)
    const known = usage.known && usage.used! > 0

    const ok = await confirm({
      title: `Delete ${row.code}?`,
      message: known
        ? `This code has been redeemed ${usage.used!.toLocaleString('en-IN')} ${usage.used === 1 ? 'time' : 'times'}. Deleting it removes the only record of what those registrations were given. This cannot be undone.`
        : `Attendees who try this code will be told it is invalid. This cannot be undone.`,
      confirmLabel: 'Delete coupon',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(row.id); setActionErr(null)
    try {
      const send = (force: boolean) => fetch(
        `${base}/${row.id}${force ? '?confirmUsed=1' : ''}`,
        { method: 'DELETE', headers: authHeaders },
      )

      let res = await send(known)

      // The server knows the redemption count even when this browser does not — a coupon
      // whose counter could not be read reaches here as "unused". It answers 409 with the
      // real number, which is the point at which the organizer can actually decide.
      if (res.status === 409) {
        const json = await res.json().catch(() => null) as { currentUses?: number; requiresConfirmation?: boolean } | null
        if (json?.requiresConfirmation) {
          const n = typeof json.currentUses === 'number' ? json.currentUses : null
          const proceed = await confirm({
            title: `${row.code} has been redeemed`,
            message: n !== null
              ? `${n.toLocaleString('en-IN')} ${n === 1 ? 'registration has' : 'registrations have'} used this code. Deleting it removes the only record of the discount they were given. Delete anyway?`
              : 'This code has already been redeemed. Deleting it removes the only record of the discount those registrations were given. Delete anyway?',
            confirmLabel: 'Delete anyway',
            tone: 'danger',
          })
          if (!proceed) return
          res = await send(true)
        }
      }

      if (!res.ok) {
        setActionErr(await readError(res, `${row.code} could not be deleted. It is unchanged.`))
        return
      }
      setCoupons(prev => prev.filter(c => c.id !== row.id))
    } catch {
      setActionErr(`${row.code} could not be deleted. It is unchanged.`)
    } finally {
      setBusyId(null)
    }
  }, [base, authHeaders, confirm])

  // ── Derived ───────────────────────────────────────────────────────────────

  const summary = useMemo(() => couponsSummary(coupons, today), [coupons, today])
  const visible = useMemo(
    () => sortCoupons(filterCoupons(coupons, filter, query, today), today),
    [coupons, filter, query, today],
  )

  // ── Loading ───────────────────────────────────────────────────────────────

  if (state === 'loading') {
    return (
      <div className="space-y-5" aria-busy="true">
        <div className="h-28 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="grid gap-3 xl:grid-cols-2">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-44 animate-pulse rounded-surface border border-border bg-muted/40" />
          ))}
        </div>
        <p className="sr-only">Loading coupons</p>
      </div>
    )
  }

  // ── Could not be read ─────────────────────────────────────────────────────

  if (state === 'error') {
    return (
      <section aria-labelledby="coupons-error" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('critical').tile)} aria-hidden>
            <AlertTriangle className="size-5" />
          </span>
          <h2 id="coupons-error" className="mt-4 text-fs-md font-semibold text-foreground">
            Coupons couldn&apos;t be loaded
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            This is a problem reading them, not a statement about how many exist. Any coupon
            already configured is still working for attendees.
          </p>
          <button type="button" onClick={reload} className={cn(PRIMARY_BTN, 'mt-5')}>
            <RefreshCw className="size-4" aria-hidden /> Try again
          </button>
        </div>
      </section>
    )
  }

  // ── Not published yet ─────────────────────────────────────────────────────

  if (!published) {
    return (
      <section aria-labelledby="coupons-draft" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('event').tile)} aria-hidden>
            <Tag className="size-5" />
          </span>
          <h2 id="coupons-draft" className="mt-4 text-fs-md font-semibold text-foreground">
            Coupons open once this event is published
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            A coupon belongs to a live event — it is checked against the registration page an
            attendee is on. This event has no published page yet, so there is nothing for a
            code to apply to. Publish it, and this workspace opens.
          </p>
        </div>
      </section>
    )
  }

  const editingRow = editingId ? coupons.find(c => c.id === editingId) ?? null : null

  // ── Nothing configured ────────────────────────────────────────────────────
  // The overview is deliberately absent here rather than rendered at zero. Four metrics
  // reading 0 · 0 · 0 · No limits above an empty list is a wall of measurements of
  // nothing — it makes an event that simply has no coupons look like one that failed.
  if (coupons.length === 0) {
    return (
      <div className="space-y-5">
        {adding ? (
          <CouponForm
            initial={BLANK}
            heading="New coupon"
            onSave={handleCreate}
            onCancel={() => { setAdding(false); setSaveErr(null) }}
            saving={saving}
            serverError={saveErr}
            passes={passes}
            noun={noun}
          />
        ) : (
          <section aria-labelledby="coupons-empty" className="min-w-0">
            <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
              <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('money').tile)} aria-hidden>
                <BadgePercent className="size-5" />
              </span>
              <h2 id="coupons-empty" className="mt-4 text-fs-md font-semibold text-foreground">
                No coupons yet
              </h2>
              <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
                A coupon is a code an attendee types at checkout to take an amount off their
                registration. You decide what it takes off, which passes it works on, when it works
                and how many times it can be used.
              </p>
              {/* RD-COUPON-SWITCH-01 — the early return skipped both switch notices, so an event with
                  no coupons offered "Create the first coupon" while RegisterDesk had them switched off. */}
              {couponsDisabledForEvent ? (
                <p role="status" className="mx-auto mt-5 flex max-w-md items-start gap-1.5 text-left text-fs-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  <span>
                    RegisterDesk has switched coupons off for this event, so <strong className="font-semibold text-foreground">new
                    coupons cannot be created and no code is accepted at checkout</strong>. Contact RegisterDesk
                    support for details.
                  </span>
                </p>
              ) : (
                <>
                  {!couponsEnabled && (
                    <p role="status" className="mx-auto mt-4 flex max-w-md items-start gap-1.5 text-left text-fs-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                      <span>
                        Coupons are switched off across the platform right now, so <strong className="font-semibold text-foreground">no
                        code will be accepted at checkout</strong> until the switch returns.
                      </span>
                    </p>
                  )}
                  <button type="button" onClick={() => setAdding(true)} className={cn(PRIMARY_BTN, 'mt-5')}>
                    Create the first coupon <ArrowRight className="size-4" aria-hidden />
                  </button>
                </>
              )}
            </div>
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* ══ OVERVIEW ══════════════════════════════════════════════════════ */}
      <section aria-labelledby="coupons-summary" className="min-w-0">
        <h2 id="coupons-summary" className="sr-only">Coupons overview</h2>

        <div className="overflow-hidden rounded-surface border border-border bg-card">
          <div className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <OverviewMetric
              icon={Tag} tone="event"
              value={String(summary.total)}
              label="Codes configured"
              sub={summary.total === 1 ? 'One code exists' : 'Across this event'}
            />
            <OverviewMetric
              icon={CheckCircle2} tone={summary.redeemable > 0 ? 'verify' : 'neutral'}
              value={String(summary.redeemable)}
              label="Redeemable today"
              sub={summary.redeemable === 0
                ? 'Nobody can redeem a code right now'
                : `of ${summary.total} configured`}
            />
            <OverviewMetric
              icon={TrendingUp} tone="people"
              value={summary.totalRedemptions === null
                ? UNAVAILABLE
                : summary.totalRedemptions.toLocaleString('en-IN')}
              unavailable={summary.totalRedemptions === null}
              label="Redemptions"
              sub={summary.totalRedemptions === null
                ? 'No counter could be read'
                : summary.countersUnknown > 0
                  ? `Excludes ${summary.countersUnknown} unreadable counter${summary.countersUnknown === 1 ? '' : 's'}`
                  : 'Recorded on the codes themselves'}
            />
            <OverviewMetric
              icon={Ticket} tone="neutral"
              value={summary.withLimits === 0 ? 'No limits' : String(summary.withLimits)}
              label={summary.withLimits === 0 ? 'Usage caps' : 'Codes with a cap'}
              sub={summary.withLimits === 0
                ? 'Every code can be used any number of times'
                : `${summary.total - summary.withLimits} unlimited`}
            />
          </div>

          {/* ── Toolbar ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search codes and descriptions"
                aria-label="Search coupons"
                className={cn(FIELD, 'h-11 pl-9 sm:h-9')}
              />
            </div>
            {!adding && !editingId && !couponsDisabledForEvent && (
              <button
                type="button"
                onClick={() => { setAdding(true); setSaveErr(null) }}
                className={cn(PRIMARY_BTN, 'shrink-0 sm:h-9')}
              >
                <Plus className="size-4" aria-hidden /> New coupon
              </button>
            )}
          </div>

          {/* ── State filters ───────────────────────────────────────────── */}
          <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2.5" role="group" aria-label="Filter by status">
            {COUPON_FILTERS.map(({ key, label }) => {
              const count = key === 'all' ? summary.total : summary.stateCounts[key as CouponState]
              // A filter that can only ever be empty is not offered — it would read as a
              // category the organizer has failed to fill.
              if (key !== 'all' && count === 0 && filter !== key) return null
              const on = filter === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-fs-xs font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    on
                      ? 'border-transparent bg-primary/[0.10] text-[color:var(--primary-text)]'
                      : 'border-border bg-card text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              )
            })}
          </div>

          {!couponsEnabled && (
            <p className="flex items-start gap-1.5 border-t border-border px-4 py-2.5 text-fs-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              Coupons are switched off across the platform right now, so <strong className="font-semibold text-foreground">no
              code below will be accepted at checkout</strong> — whatever its status says here.
              Your configuration is kept and starts working again when the switch returns.
            </p>
          )}

          {couponsEnabled && couponsDisabledForEvent && (
            <p className="flex items-start gap-1.5 border-t border-border px-4 py-2.5 text-fs-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              RegisterDesk has switched coupons off for this event, so <strong className="font-semibold text-foreground">no
              code below will be accepted at checkout</strong> and new coupons cannot be created. Your coupons
              are kept and start working again if they are switched back on. Contact RegisterDesk support for details.
            </p>
          )}

          {truncated && (
            <p className="flex items-start gap-1.5 border-t border-border px-4 py-2.5 text-fs-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              This event has more coupons than are shown. The most recent are listed; the
              figures above describe only those.
            </p>
          )}
        </div>
      </section>

      {actionErr && (
        <p role="alert" className={cn(
          'flex items-start gap-2 rounded-surface border px-3.5 py-2.5 text-fs-xs',
          'border-critical/25 text-critical',
        )}>
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{actionErr}</span>
          <button type="button" onClick={() => setActionErr(null)} aria-label="Dismiss"
                  className="shrink-0 rounded-control p-0.5 hover:bg-critical/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <X className="size-3.5" aria-hidden />
          </button>
        </p>
      )}

      {/* ══ CREATE ════════════════════════════════════════════════════════ */}
      {adding && (
        <CouponForm
          initial={BLANK}
          heading="New coupon"
          onSave={handleCreate}
          onCancel={() => { setAdding(false); setSaveErr(null) }}
          saving={saving}
          serverError={saveErr}
          passes={passes}
          noun={noun}
        />
      )}

      {/* ══ THE COUPONS ═══════════════════════════════════════════════════ */}
        <section aria-labelledby="coupons-list" className="min-w-0">
          <h2 id="coupons-list" className="mb-2 text-fs-sm font-semibold text-foreground">
            {filter === 'all' && !query.trim()
              ? 'All coupons'
              : `${visible.length} of ${coupons.length} shown`}
          </h2>

          {visible.length === 0 ? (
            <div className="rounded-surface border border-dashed border-border px-4 py-10 text-center">
              <p className="text-fs-sm font-medium text-foreground">{couponEmptyMessage(filter, query)}</p>
              <p className="mt-1 text-fs-xs text-muted-foreground">
                {coupons.length} coupon{coupons.length === 1 ? '' : 's'} configured on this event.
              </p>
              <button
                type="button"
                onClick={() => { setFilter('all'); setQuery('') }}
                className={cn(GHOST_BTN, 'mt-4 h-11')}
              >
                Show all coupons
              </button>
            </div>
          ) : (
            <ul className="grid min-w-0 gap-3 xl:grid-cols-2">
              {visible.map(row =>
                editingRow?.id === row.id ? (
                  <li key={row.id} className="min-w-0 xl:col-span-2">
                    <CouponForm
                      initial={formFromRow(row)}
                      heading={`Edit ${row.code}`}
                      onSave={input => handleUpdate(row.id, input)}
                      onCancel={() => { setEditingId(null); setSaveErr(null) }}
                      saving={saving}
                      serverError={saveErr}
                      passes={passes}
                      noun={noun}
                    />
                  </li>
                ) : (
                  <CouponModule
                    key={row.id}
                    row={row}
                    today={today}
                    passes={passes}
                    noun={noun}
                    busy={busyId === row.id}
                    onEdit={() => { setEditingId(row.id); setAdding(false); setSaveErr(null) }}
                    onToggle={() => void handleToggle(row)}
                    onDelete={() => void handleDelete(row)}
                  />
                ),
              )}
            </ul>
          )}

          {/* The vocabulary, once, at the bottom — so "Limit reached" and "Expired" do not
              have to be guessed at from a coloured pill. */}
          <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
            A code&apos;s status is what the checkout would actually do with it today, not
            just its on/off switch: <strong className="font-medium text-foreground">Scheduled</strong> has
            not opened yet, <strong className="font-medium text-foreground">Expired</strong> is past its
            end date, <strong className="font-medium text-foreground">Limit reached</strong> has been
            used up, and <strong className="font-medium text-foreground">Inactive</strong> is switched off.
          </p>
        </section>
    </div>
  )
}
