'use client'

// Event License comparison cards + summary panel for the wizard's License step.
// Presentational only: it reports the organizer's selection upward and performs NO
// payment. RD-LICENSE-GA-03: renders the CURRENT-version catalog view (useCurrentLicense
// CatalogView) — the tiers the write layer validates against — so the selection is always
// valid for CURRENT_LICENSE_VERSION (V1 today, V2 after the cutover). It shows the regular
// (strike-through) + offer price; the payment summary charges the OFFER price.

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { isUnlimited, type AnyEventLicenseTier } from '@/lib/licensing/eventLicense'
import { useCurrentLicenseCatalogView } from '@/lib/licensing/licenseCatalogClient'
import type { LicenseCatalogEntryView } from '@/lib/licensing/licenseCatalogShared'

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`

/** The CHARGED (offer) price label. */
function priceLabel(e: LicenseCatalogEntryView): string {
  if (e.contactSales) return 'Contact Sales'
  if (e.offerPricePaise === 0) return 'FREE'
  return rupees(e.offerPricePaise)
}

/** The struck-through REGULAR price, only when there's a real discount (never ₹0). */
function regularLabel(e: LicenseCatalogEntryView): string | null {
  return e.offerPricePaise > 0 && e.regularPricePaise > e.offerPricePaise ? rupees(e.regularPricePaise) : null
}

function registrationLimitLabel(e: LicenseCatalogEntryView): string {
  return isUnlimited(e.registrationLimit) ? 'Unlimited' : e.registrationLimit.toLocaleString('en-IN')
}

// ─── Card ───────────────────────────────────────────────────────────────────

function LicenseCard({
  entry, selected, onSelect,
}: {
  entry:    LicenseCatalogEntryView
  selected: boolean
  onSelect: (t: AnyEventLicenseTier) => void
}) {
  const regular = regularLabel(entry)
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.tier)}
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

      <p className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{entry.name}</p>
      <p className="mt-1 flex items-baseline gap-1.5">
        {regular && <span className="text-[13px] font-medium text-muted-foreground line-through">{regular}</span>}
        <span className="text-[22px] font-bold tracking-tight text-foreground">{priceLabel(entry)}</span>
      </p>
      {entry.offerPricePaise > 0 && (
        <p className="text-[11.5px] text-muted-foreground">one-time, per event</p>
      )}
      <p className="mt-0.5 text-[12px] font-medium text-foreground">
        {registrationLimitLabel(entry)} registrations
      </p>

      <ul className="mt-3 space-y-1.5">
        {entry.featureList.map(item => (
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
  selected:           AnyEventLicenseTier
  walletBalancePaise: number | null
}) {
  const view = useCurrentLicenseCatalogView()
  const entry = view.find(e => e.tier === selected) ?? view[0]
  const payablePaise = entry.contactSales ? null : entry.offerPricePaise   // charge the OFFER price
  const regular      = regularLabel(entry)
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
        {row('Selected license', entry.name)}
        {regular && row('Regular price', regular)}
        {row('Price', priceLabel(entry))}
        {row('Registration limit', registrationLimitLabel(entry))}
        {row('Wallet balance', walletBalancePaise == null ? '—' : rupees(balance))}
        {payablePaise != null && payablePaise > 0 && row('Wallet used', rupees(walletUsed))}
        {payablePaise != null && payablePaise > 0 && row('Additional payment', rupees(additional))}
        {row('GST', 'Included later')}
        <div className="my-1 border-t border-border" />
        {row('Total', entry.contactSales ? 'Contact Sales' : rupees(totalPaise ?? 0), true)}
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
  selected:           AnyEventLicenseTier
  onSelect:           (t: AnyEventLicenseTier) => void
  walletBalancePaise: number | null
}) {
  const view = useCurrentLicenseCatalogView()
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {view.map(entry => (
          <LicenseCard key={entry.tier} entry={entry} selected={selected === entry.tier} onSelect={onSelect} />
        ))}
      </div>
      <div className="max-w-md">
        <LicenseSummary selected={selected} walletBalancePaise={walletBalancePaise} />
      </div>
    </div>
  )
}
