'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { auth }               from '@/lib/firebase/auth'
import { cn }                 from '@/lib/utils/cn'
import {
  AlertCircle, BadgeCheck, Building2, ChevronLeft,
  CreditCard, Loader2, Save, ShieldAlert, Smartphone,
} from 'lucide-react'
import type {
  PayoutMethod,
  PayoutProfileSummary,
  PayoutProfileGetResponse,
  PayoutProfilePutResponse,
} from '@/lib/payout/types'

// ─── Validation ───────────────────────────────────────────────────────────────

const PAN_RE  = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const UPI_RE  = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/

type FieldErrors = Partial<Record<
  'accountHolderName' | 'bankName' | 'accountNumber' | 'ifscCode' | 'upiId' | 'panNumber',
  string
>>

function validate(
  method: PayoutMethod,
  f: {
    accountHolderName: string; bankName: string; accountNumber: string
    ifscCode: string; upiId: string; panNumber: string
  },
): FieldErrors {
  const e: FieldErrors = {}
  if (!f.accountHolderName) e.accountHolderName = 'Account holder name is required.'
  if (method === 'bank') {
    if (!f.bankName)     e.bankName     = 'Bank name is required.'
    if (!f.accountNumber) e.accountNumber = 'Account number is required.'
    if (!f.ifscCode)     e.ifscCode     = 'IFSC code is required.'
    else if (!IFSC_RE.test(f.ifscCode.toUpperCase()))
      e.ifscCode = 'Invalid IFSC. Format: ABCD0123456'
  }
  if (method === 'upi') {
    if (!f.upiId) e.upiId = 'UPI ID is required.'
    else if (!UPI_RE.test(f.upiId))
      e.upiId = 'Invalid UPI ID. Format: name@bank'
  }
  if (!f.panNumber) e.panNumber = 'PAN number is required.'
  else if (!PAN_RE.test(f.panNumber.toUpperCase()))
    e.panNumber = 'Invalid PAN. Format: ABCDE1234F'
  return e
}

// ─── Form field ───────────────────────────────────────────────────────────────

function Field({
  label, id, value, onChange, error, placeholder, hint, upper = false, disabled = false,
}: {
  label: string; id: string; value: string
  onChange: (v: string) => void; error?: string
  placeholder?: string; hint?: string; upper?: boolean; disabled?: boolean
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        disabled={disabled}
        value={value}
        onChange={e => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
        placeholder={placeholder}
        className={cn(
          'w-full rounded-lg border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none',
          'placeholder:text-muted-foreground transition-colors',
          'focus:border-primary/50 focus:ring-2 focus:ring-primary/25',
          error ? 'border-destructive' : 'border-border',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      />
      {error && (
        <p className="mt-1 flex items-center gap-1 text-[12px] text-destructive">
          <AlertCircle className="size-3 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface FormState {
  accountHolderName: string
  payoutMethod:      PayoutMethod
  bankName:          string
  accountNumber:     string
  ifscCode:          string
  upiId:             string
  panNumber:         string
  gstNumber:         string
}

const EMPTY: FormState = {
  accountHolderName: '',
  payoutMethod:      'bank',
  bankName:          '',
  accountNumber:     '',
  ifscCode:          '',
  upiId:             '',
  panNumber:         '',
  gstNumber:         '',
}

function profileToForm(p: PayoutProfileSummary): FormState {
  return {
    accountHolderName: p.accountHolderName,
    payoutMethod:      p.payoutMethod,
    bankName:          p.bankName       ?? '',
    accountNumber:     p.accountNumber  ?? '',
    ifscCode:          p.ifscCode       ?? '',
    upiId:             p.upiId          ?? '',
    panNumber:         p.panNumber,
    gstNumber:         p.gstNumber      ?? '',
  }
}

export default function PayoutProfilePage() {
  const [token,       setToken]       = useState('')
  const [profile,     setProfile]     = useState<PayoutProfileSummary | null | undefined>(undefined)
  const [loadError,   setLoadError]   = useState<string | null>(null)

  const [form,        setForm]        = useState<FormState>(EMPTY)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [saveError,   setSaveError]   = useState<string | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [savedAt,     setSavedAt]     = useState<string | null>(null)

  // Track initial form to detect "first save" for the success message
  const savedOnce = useRef(false)

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setProfile(null); return }
      try {
        const t   = await user.getIdToken()
        setToken(t)
        const res = await fetch('/api/organizer/payout-profile', {
          headers: { Authorization: `Bearer ${t}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as PayoutProfileGetResponse
        setProfile(data.profile)
        if (data.profile) setForm(profileToForm(data.profile))
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Failed to load payout profile.')
        setProfile(null)
      }
    })
    return unsub
  }, [])

  const setField = useCallback(<K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setFieldErrors(prev => { const n = { ...prev }; delete n[key as keyof FieldErrors]; return n })
    setSaveError(null)
    setSavedAt(null)
  }, [])

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errors = validate(form.payoutMethod, form)
    if (Object.keys(errors).length > 0) { setFieldErrors(errors); return }

    setSaving(true)
    setSaveError(null)
    setSavedAt(null)

    try {
      const res = await fetch('/api/organizer/payout-profile', {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({
          accountHolderName: form.accountHolderName,
          payoutMethod:      form.payoutMethod,
          bankName:          form.bankName     || undefined,
          accountNumber:     form.accountNumber || undefined,
          ifscCode:          form.ifscCode.toUpperCase() || undefined,
          upiId:             form.upiId        || undefined,
          panNumber:         form.panNumber.toUpperCase(),
          gstNumber:         form.gstNumber    || undefined,
        }),
      })

      if (!res.ok) {
        const body = await res.json() as { error?: string; fields?: Record<string, string> }
        if (body.fields) setFieldErrors(body.fields as FieldErrors)
        setSaveError(body.error ?? `Save failed (${res.status})`)
        return
      }

      const data    = await res.json() as PayoutProfilePutResponse
      setProfile(data.profile)
      setForm(profileToForm(data.profile))
      setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
      savedOnce.current = true
    } catch {
      setSaveError('Network error — please try again.')
    } finally {
      setSaving(false)
    }
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────

  if (profile === undefined) {
    return (
      <div className="space-y-5 pb-12">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-pulse rounded bg-muted" />
          <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-[480px] animate-pulse rounded-xl bg-muted" />
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isBank = form.payoutMethod === 'bank'

  return (
    <div className="space-y-5 pb-12">

      {/* ── Header ── */}
      <div>
        <Link
          href="/dashboard/finance"
          className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          Finance
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-foreground">Payout Profile</h1>
            <p className="mt-0.5 text-[14px] text-muted-foreground">
              Configure where your settlements are sent.
            </p>
          </div>

          {/* Verification badge */}
          {profile && (
            profile.isVerified ? (
              <div className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12.5px] font-semibold text-emerald-700 dark:border-emerald-700/30 dark:bg-emerald-900/20 dark:text-emerald-400">
                <BadgeCheck className="size-3.5" aria-hidden />
                Verified
              </div>
            ) : (
              <div className="flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12.5px] font-semibold text-amber-700 dark:border-amber-700/30 dark:bg-amber-900/20 dark:text-amber-400">
                <ShieldAlert className="size-3.5" aria-hidden />
                Pending Verification
              </div>
            )
          )}
        </div>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-[13.5px] text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          {loadError}
        </div>
      )}

      {/* ── Form card ── */}
      <form
        onSubmit={handleSubmit}
        noValidate
        className="rounded-xl border border-border bg-card shadow-sm"
      >
        {/* ── Method toggle ── */}
        <div className="border-b border-border px-6 py-4">
          <p className="mb-3 text-[13px] font-medium text-muted-foreground">Payout method</p>
          <div className="flex gap-3">
            {(
              [
                { method: 'bank', icon: Building2, label: 'Bank Transfer' },
                { method: 'upi',  icon: Smartphone, label: 'UPI'          },
              ] as { method: PayoutMethod; icon: React.ElementType; label: string }[]
            ).map(({ method, icon: Icon, label }) => (
              <button
                key={method}
                type="button"
                onClick={() => setField('payoutMethod', method)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border px-4 py-3 text-[13.5px] font-medium transition-all',
                  form.payoutMethod === method
                    ? 'border-primary bg-primary/[0.06] text-primary shadow-sm'
                    : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground',
                )}
                aria-pressed={form.payoutMethod === method}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Form fields ── */}
        <div className="space-y-5 px-6 py-6">

          <Field
            id="accountHolderName"
            label="Account Holder Name"
            value={form.accountHolderName}
            onChange={v => setField('accountHolderName', v)}
            error={fieldErrors.accountHolderName}
            placeholder="As it appears on your bank account"
          />

          {isBank && (
            <>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field
                  id="bankName"
                  label="Bank Name"
                  value={form.bankName}
                  onChange={v => setField('bankName', v)}
                  error={fieldErrors.bankName}
                  placeholder="e.g. HDFC Bank"
                />
                <Field
                  id="accountNumber"
                  label="Account Number"
                  value={form.accountNumber}
                  onChange={v => setField('accountNumber', v)}
                  error={fieldErrors.accountNumber}
                  placeholder="Your account number"
                />
              </div>
              <Field
                id="ifscCode"
                label="IFSC Code"
                value={form.ifscCode}
                onChange={v => setField('ifscCode', v.toUpperCase())}
                error={fieldErrors.ifscCode}
                placeholder="e.g. HDFC0001234"
                hint="11-character code found on your cheque book"
                upper
              />
            </>
          )}

          {!isBank && (
            <Field
              id="upiId"
              label="UPI ID"
              value={form.upiId}
              onChange={v => setField('upiId', v)}
              error={fieldErrors.upiId}
              placeholder="e.g. name@okicici"
              hint="The UPI ID registered with your payment app"
            />
          )}

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field
              id="panNumber"
              label="PAN Number"
              value={form.panNumber}
              onChange={v => setField('panNumber', v.toUpperCase())}
              error={fieldErrors.panNumber}
              placeholder="e.g. ABCDE1234F"
              hint="Required for TDS compliance"
              upper
            />
            <Field
              id="gstNumber"
              label="GST Number (optional)"
              value={form.gstNumber}
              onChange={v => setField('gstNumber', v.toUpperCase())}
              placeholder="e.g. 27AAPFU0939F1ZV"
              upper
            />
          </div>

          {/* ── Info note ── */}
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <CreditCard className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-[12.5px] text-muted-foreground">
              Your payout details are used only for settlement transfers. Updating your profile
              resets verification status — our team will re-verify within 1–2 business days.
            </p>
          </div>

          {/* ── Save error ── */}
          {saveError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <p className="text-[13px] text-destructive">{saveError}</p>
            </div>
          )}

          {/* ── Success message ── */}
          {savedAt && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 dark:border-emerald-700/30 dark:bg-emerald-900/20">
              <BadgeCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <p className="text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
                Profile saved at {savedAt}. Pending admin verification.
              </p>
            </div>
          )}

          {/* ── Actions ── */}
          <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
            <Link
              href="/dashboard/finance"
              className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              {saving
                ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                : <Save    className="size-3.5" aria-hidden />
              }
              {saving ? 'Saving…' : profile ? 'Update Profile' : 'Save Profile'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
