'use client'

import { useState, useEffect, useCallback } from 'react'
import { Tag, Plus, Pencil, Trash2, Check, X, Loader2, ToggleLeft, ToggleRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import type { CouponType } from '@/lib/coupons/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CouponRow {
  id:                string
  code:              string
  description:       string
  type:              CouponType
  value:             number
  active:            boolean
  validFrom:         string | null
  validUntil:        string | null
  maxUses:           number | null
  currentUses:       number
  applicablePassIds: string[]
}

interface FormState {
  code:        string
  description: string
  type:        CouponType
  value:       string
  active:      boolean
  validFrom:   string
  validUntil:  string
  maxUses:     string
}

const BLANK: FormState = {
  code:        '',
  description: '',
  type:        'percentage',
  value:       '',
  active:      true,
  validFrom:   '',
  validUntil:  '',
  maxUses:     '',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtValue(coupon: CouponRow): string {
  if (coupon.type === 'percentage') return `${coupon.value}% off`
  if (coupon.type === 'fixed') {
    const rupees = coupon.value / 100
    return `₹${rupees.toLocaleString('en-IN')} off`
  }
  return '100% free'
}

// ─── Inline form ──────────────────────────────────────────────────────────────

function CouponForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial:  FormState
  onSave:   (f: FormState) => void
  onCancel: () => void
  saving:   boolean
}) {
  const [f, setF] = useState<FormState>(initial)
  const set = (k: keyof FormState, v: string | boolean) => setF(p => ({ ...p, [k]: v }))

  const labelCls = 'block text-[13px] font-medium text-foreground mb-1'
  const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/40'

  return (
    <form
      onSubmit={e => { e.preventDefault(); onSave(f) }}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 sm:col-span-1">
          <label className={labelCls}>Code</label>
          <input
            className={inputCls + ' uppercase'}
            value={f.code}
            onChange={e => set('code', e.target.value.toUpperCase())}
            placeholder="e.g. EARLYBIRD20"
            required
            maxLength={30}
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <label className={labelCls}>Type</label>
          <select
            className={inputCls}
            value={f.type}
            onChange={e => set('type', e.target.value)}
          >
            <option value="percentage">Percentage off</option>
            <option value="fixed">Fixed amount off</option>
            <option value="free">Free (100% off)</option>
          </select>
        </div>

        <div className="col-span-2">
          <label className={labelCls}>Description</label>
          <input
            className={inputCls}
            value={f.description}
            onChange={e => set('description', e.target.value)}
            placeholder="e.g. Early bird discount"
            required
          />
        </div>

        {f.type !== 'free' && (
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>
              {f.type === 'percentage' ? 'Discount %' : 'Discount amount (₹)'}
            </label>
            <input
              className={inputCls}
              type="number"
              min={f.type === 'percentage' ? 1 : 0.01}
              max={f.type === 'percentage' ? 100 : undefined}
              step={f.type === 'percentage' ? 1 : 0.01}
              value={f.value}
              onChange={e => set('value', e.target.value)}
              required
            />
          </div>
        )}

        <div className="col-span-2 sm:col-span-1">
          <label className={labelCls}>Max uses (blank = unlimited)</label>
          <input
            className={inputCls}
            type="number"
            min={1}
            value={f.maxUses}
            onChange={e => set('maxUses', e.target.value)}
            placeholder="Unlimited"
          />
        </div>

        <div>
          <label className={labelCls}>Valid from</label>
          <input
            className={inputCls}
            type="date"
            value={f.validFrom}
            onChange={e => set('validFrom', e.target.value)}
          />
        </div>

        <div>
          <label className={labelCls}>Valid until</label>
          <input
            className={inputCls}
            type="date"
            value={f.validUntil}
            onChange={e => set('validUntil', e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="coupon-active"
          checked={f.active}
          onChange={e => set('active', e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        <label htmlFor="coupon-active" className="text-[13px] text-foreground">Active</label>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-60"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground hover:bg-muted/60"
        >
          <X className="size-3.5" />
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── Coupon card ──────────────────────────────────────────────────────────────

function CouponCard({
  coupon,
  onEdit,
  onToggle,
  onDelete,
  token,
  eventId,
}: {
  coupon:   CouponRow
  onEdit:   () => void
  onToggle: () => void
  onDelete: () => void
  token:    string
  eventId:  string
}) {
  const pct = coupon.maxUses ? Math.round((coupon.currentUses / coupon.maxUses) * 100) : null

  return (
    <div className={cn(
      'rounded-xl border bg-card p-4 transition-opacity',
      !coupon.active && 'opacity-60',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Tag className="size-4 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-mono text-[15px] font-bold text-foreground">{coupon.code}</p>
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                coupon.active
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-muted text-muted-foreground',
              )}>
                {coupon.active ? 'Active' : 'Inactive'}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{coupon.description}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title={coupon.active ? 'Deactivate' : 'Activate'}
            onClick={onToggle}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            {coupon.active
              ? <ToggleRight className="size-4 text-emerald-600" />
              : <ToggleLeft  className="size-4" />
            }
          </button>
          <button
            type="button"
            title="Edit"
            onClick={onEdit}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            title="Delete"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[12px]">
        <div className="rounded-lg bg-muted/40 py-2">
          <p className="font-semibold text-foreground">{fmtValue(coupon)}</p>
          <p className="text-muted-foreground">Discount</p>
        </div>
        <div className="rounded-lg bg-muted/40 py-2">
          <p className="font-semibold text-foreground">{coupon.currentUses}</p>
          <p className="text-muted-foreground">Used</p>
        </div>
        <div className="rounded-lg bg-muted/40 py-2">
          <p className="font-semibold text-foreground">
            {coupon.maxUses ? `${coupon.maxUses - coupon.currentUses} left` : '∞'}
          </p>
          <p className="text-muted-foreground">Remaining</p>
        </div>
      </div>

      {pct !== null && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', pct >= 90 ? 'bg-red-500' : 'bg-primary')}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {(coupon.validFrom || coupon.validUntil) && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {coupon.validFrom  ? `From ${coupon.validFrom}` : ''}
          {coupon.validFrom && coupon.validUntil ? ' · ' : ''}
          {coupon.validUntil ? `Until ${coupon.validUntil}` : ''}
        </p>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CouponsTab({
  eventId,
  token,
}: {
  eventId: string
  token:   string
}) {
  const [coupons,   setCoupons]   = useState<CouponRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [adding,    setAdding]    = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [saveErr,   setSaveErr]   = useState<string | null>(null)
  const { confirm } = useConfirm()

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const base    = `/api/organizer/events/${eventId}/coupons`

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res  = await fetch(base, { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json() as { coupons?: CouponRow[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to load coupons')
      setCoupons(json.coupons ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load coupons')
    } finally {
      setLoading(false)
    }
  }, [base, token])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load() }, [load])

  function buildPayload(f: FormState) {
    return {
      code:        f.code.toUpperCase(),
      description: f.description,
      type:        f.type,
      value:       f.type === 'free' ? 100
        : f.type === 'fixed'         ? Math.round(parseFloat(f.value) * 100)
        : parseFloat(f.value),
      active:     f.active,
      validFrom:  f.validFrom  || null,
      validUntil: f.validUntil || null,
      maxUses:    f.maxUses ? parseInt(f.maxUses, 10) : null,
    }
  }

  async function handleCreate(f: FormState) {
    setSaving(true); setSaveErr(null)
    try {
      const res  = await fetch(base, { method: 'POST', headers, body: JSON.stringify(buildPayload(f)) })
      const json = await res.json() as { coupon?: CouponRow; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to create coupon')
      setCoupons(prev => [json.coupon!, ...prev])
      setAdding(false)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate(id: string, f: FormState) {
    setSaving(true); setSaveErr(null)
    try {
      const res  = await fetch(`${base}/${id}`, { method: 'PATCH', headers, body: JSON.stringify(buildPayload(f)) })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to update coupon')
      setEditingId(null)
      await load()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(coupon: CouponRow) {
    try {
      await fetch(`${base}/${coupon.id}`, {
        method:  'PATCH',
        headers,
        body:    JSON.stringify({ active: !coupon.active }),
      })
      setCoupons(prev => prev.map(c => c.id === coupon.id ? { ...c, active: !c.active } : c))
    } catch {
      // non-critical
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirm({ message: 'Delete this coupon? This cannot be undone.', tone: 'danger' }))) return
    try {
      await fetch(`${base}/${id}`, { method: 'DELETE', headers })
      setCoupons(prev => prev.filter(c => c.id !== id))
    } catch {
      // non-critical
    }
  }

  function editInitial(coupon: CouponRow): FormState {
    return {
      code:        coupon.code,
      description: coupon.description,
      type:        coupon.type,
      value:       coupon.type === 'fixed'
        ? String(coupon.value / 100)
        : String(coupon.value),
      active:     coupon.active,
      validFrom:  coupon.validFrom  ?? '',
      validUntil: coupon.validUntil ?? '',
      maxUses:    coupon.maxUses != null ? String(coupon.maxUses) : '',
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />)}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-[14px] text-red-700">{error}</div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[16px] font-semibold text-foreground">Coupons &amp; Promo Codes</p>
          <p className="text-[13px] text-muted-foreground">{coupons.length} coupon{coupons.length !== 1 ? 's' : ''}</p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => { setAdding(true); setSaveErr(null) }}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground"
          >
            <Plus className="size-3.5" />
            Add coupon
          </button>
        )}
      </div>

      {saveErr && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{saveErr}</p>
      )}

      {/* Add form */}
      {adding && (
        <CouponForm
          initial={BLANK}
          onSave={handleCreate}
          onCancel={() => { setAdding(false); setSaveErr(null) }}
          saving={saving}
        />
      )}

      {/* List */}
      {coupons.length === 0 && !adding ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center">
          <Tag className="mx-auto mb-3 size-8 text-muted-foreground/40" />
          <p className="text-[14px] font-semibold text-foreground">No coupons yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Create a coupon to offer discounts to attendees.
          </p>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground mx-auto"
          >
            <Plus className="size-3.5" />
            Add first coupon
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {coupons.map(coupon =>
            editingId === coupon.id ? (
              <CouponForm
                key={coupon.id}
                initial={editInitial(coupon)}
                onSave={f => handleUpdate(coupon.id, f)}
                onCancel={() => { setEditingId(null); setSaveErr(null) }}
                saving={saving}
              />
            ) : (
              <CouponCard
                key={coupon.id}
                coupon={coupon}
                onEdit={() => { setEditingId(coupon.id); setSaveErr(null) }}
                onToggle={() => handleToggle(coupon)}
                onDelete={() => handleDelete(coupon.id)}
                token={token}
                eventId={eventId}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}
