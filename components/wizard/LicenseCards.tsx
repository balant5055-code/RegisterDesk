'use client'

// Event License comparison cards + summary panel for the wizard's License step.
// Presentational only: it reports the organizer's selection upward and performs NO
// payment. It renders the EFFECTIVE license catalog (config overrides merged onto
// the eventLicense.ts defaults) via useLicenseCatalog, so the price/limit shown
// matches exactly what the server charges and enforces.

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  EVENT_LICENSE_TIERS,
  isUnlimited,
  type EventLicenseTier,
  type EventLicenseDefinition,
} from '@/lib/licensing/eventLicense'
import { useLicenseCatalog } from '@/lib/licensing/licenseCatalogClient'

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`

function priceLabel(def: EventLicenseDefinition): string {
  if (def.contactSales) return 'Contact Sales'
  if (def.licensePricePaise === 0) return 'FREE'
  return rupees(def.licensePricePaise)
}

function registrationLimitLabel(def: EventLicenseDefinition): string {
  const max = def.limits.maxRegistrations
  return isUnlimited(max) ? 'Unlimited' : max.toLocaleString('en-IN')
}

// ─── Card ───────────────────────────────────────────────────────────────────

function LicenseCard({
  def, selected, onSelect,
}: {
  def:      EventLicenseDefinition
  selected: boolean
  onSelect: (t: EventLicenseTier) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(def.tier)}
      aria-pressed={selected}
      className={cn(
        'group relative flex flex-col rounded-xl border bg-card p-4 text-left transition-all duration-200',
        selected
          ? 'border-primary shadow-md ring-2 ring-primary/15'
          : 'border-border hover:border-border-strong hover:shadow-sm',
      )}
    >
      {selected && (
        <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3.5" aria-hidden />
        </span>
      )}

      <p className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{def.name}</p>
      <p className="mt-1 text-[22px] font-bold tracking-tight text-foreground">{priceLabel(def)}</p>
      {def.licensePricePaise > 0 && (
        <p className="text-[11.5px] text-muted-foreground">one-time, per event</p>
      )}
      <p className="mt-0.5 text-[12px] font-medium text-foreground">
        {registrationLimitLabel(def)} registrations
      </p>

      <ul className="mt-3 space-y-1.5">
        {def.featureList.map(item => (
          <li key={item} className="flex items-start gap-1.5 text-[12.5px] text-foreground">
            <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </button>
  )
}

// ─── Summary panel ────────────────────────────────────────────────────────────

export function LicenseSummary({
  selected, walletBalancePaise,
}: {
  selected:           EventLicenseTier
  walletBalancePaise: number | null
}) {
  const catalog      = useLicenseCatalog()
  const def          = catalog[selected]
  const payablePaise = def.contactSales ? null : def.licensePricePaise
  const balance      = walletBalancePaise ?? 0
  const walletUsed   = payablePaise != null ? Math.min(balance, payablePaise) : 0
  const additional   = payablePaise != null ? Math.max(0, payablePaise - balance) : 0
  const gstPaise     = 0   // placeholder — GST is not applied yet
  const totalPaise   = payablePaise != null ? payablePaise + gstPaise : null

  const row = (label: string, value: string, strong = false) => (
    <div className="flex items-center justify-between gap-3 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? 'font-semibold text-foreground' : 'font-medium text-foreground'}>{value}</dd>
    </div>
  )

  return (
    <div className="rounded-xl border border-border bg-muted/[0.04] p-4 text-[13px]">
      <p className="mb-2 text-[13px] font-semibold text-foreground">Payment summary</p>
      <dl>
        {row('Selected license', def.name)}
        {row('Price', priceLabel(def))}
        {row('Registration limit', registrationLimitLabel(def))}
        {row('Wallet balance', walletBalancePaise == null ? '—' : rupees(balance))}
        {payablePaise != null && payablePaise > 0 && row('Wallet used', rupees(walletUsed))}
        {payablePaise != null && payablePaise > 0 && row('Additional payment', rupees(additional))}
        {row('GST', 'Included later')}
        <div className="my-1 border-t border-border" />
        {row('Total', def.contactSales ? 'Contact Sales' : rupees(totalPaise ?? 0), true)}
      </dl>
      {additional > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          Additional payment via Razorpay: <span className="font-semibold">{rupees(additional)}</span>
        </div>
      )}
    </div>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────

export function LicenseCards({
  selected, onSelect, walletBalancePaise,
}: {
  selected:           EventLicenseTier
  onSelect:           (t: EventLicenseTier) => void
  walletBalancePaise: number | null
}) {
  const catalog = useLicenseCatalog()
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EVENT_LICENSE_TIERS.map(tier => (
          <LicenseCard key={tier} def={catalog[tier]} selected={selected === tier} onSelect={onSelect} />
        ))}
      </div>
      <div className="max-w-md">
        <LicenseSummary selected={selected} walletBalancePaise={walletBalancePaise} />
      </div>
    </div>
  )
}
