// /donations/receipt/[receiptId]
//
// Public receipt view — accessible to anyone holding a valid signed token.
//
// Access paths:
//   • ?token=<hmac>  Donor link from success page or email
//   • Authorization: Bearer <firebase-id-token>  (checked by the PDF API, not here)
//
// This page is intentionally light: no navbar, no sidebar, no CTA.
// It serves as a permanent shareable record for the donor.

import { notFound }          from 'next/navigation'
import { MarketingNavbar }   from '@/components/marketing/navigation/MarketingNavbar'
import { getDonationReceipt } from '@/lib/firebase/firestore/donations'
import { getDonation }        from '@/lib/firebase/firestore/donations'
import { getCampaignBySlug }  from '@/lib/firebase/firestore/campaigns'
import { verifyReceiptToken } from '@/lib/donations/receiptToken'
import { fmtReceiptDate }     from '@/lib/donations/receiptPdf'
import { Download, Shield }   from 'lucide-react'
import { buttonVariants }     from '@/components/ui/button'
import { cn }                 from '@/lib/utils/cn'

export const dynamic = 'force-dynamic'

type PageProps = {
  params:      Promise<{ receiptId: string }>
  searchParams: Promise<{ token?: string }>
}

function toDate(val: unknown): Date {
  if (val && typeof val === 'object' && 'toDate' in val) {
    return (val as { toDate: () => Date }).toDate()
  }
  return new Date()
}

function fmtINR(rupees: number): string {
  try {
    return 'INR ' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees)
  } catch {
    return `INR ${rupees.toLocaleString()}`
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground break-all">{value}</dd>
    </div>
  )
}

export default async function DonationReceiptPage({ params, searchParams }: PageProps) {
  const { receiptId } = await params
  const { token }     = await searchParams

  // Verify token
  if (!token || !verifyReceiptToken(receiptId, token)) {
    notFound()
  }

  // Load data
  const receipt = await getDonationReceipt(receiptId)
  if (!receipt) notFound()

  const [donation, campaign] = await Promise.all([
    getDonation(receipt.donationId),
    getCampaignBySlug(receipt.campaignSlug),
  ])

  const cd           = campaign?.campaignDetails
  const organizerName = cd?.organizer?.name ?? 'Organization'
  const paidAt        = toDate(receipt.paidAt)
  const downloadUrl   = `/api/donations/receipt/${receiptId}?token=${token}`
  const isRefunded    = receipt.status === 'refunded'

  return (
    <div className={cn('relative min-h-screen bg-background', isRefunded && 'overflow-hidden')}>
      <MarketingNavbar />

      {/* REFUNDED watermark — shown for fully-refunded receipts (still downloadable) */}
      {isRefunded && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center" aria-hidden>
          <span className="rotate-[-30deg] select-none text-[68px] font-black uppercase tracking-widest text-red-500/10">
            Refunded
          </span>
        </div>
      )}

      <div className="relative z-10 mx-auto max-w-lg px-4 py-10">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mb-3 inline-flex size-14 items-center justify-center rounded-full bg-orange-100">
            <Shield className="size-7 text-orange-600" aria-hidden />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Donation Receipt</h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">{receipt.receiptNumber}</p>
          {isRefunded && (
            <p className="mt-2 inline-flex items-center rounded-full bg-red-50 px-3 py-1 text-[12px] font-semibold text-red-700 ring-1 ring-red-600/20">
              This donation was refunded
            </p>
          )}
        </div>

        {/* Amount */}
        <div className="mb-6 rounded-2xl border border-orange-200 bg-orange-50 p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
            Amount Donated
          </p>
          <p className="mt-1 text-4xl font-bold text-orange-700">
            {fmtINR(receipt.amountRupees)}
          </p>
          <p className="mt-1 text-sm text-orange-600">{fmtReceiptDate(paidAt)}</p>
        </div>

        {/* Details card */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <dl className="divide-y divide-border">
            <Row label="Campaign"       value={receipt.campaignTitle} />
            <Row label="Organization"   value={organizerName} />
            <Row label="Donor"          value={receipt.donorName} />
            <Row label="Email"          value={receipt.donorEmail} />
            <Row label="Receipt Number" value={receipt.receiptNumber} />
            <Row label="Date"           value={fmtReceiptDate(paidAt)} />
            {donation?.razorpayPaymentId && (
              <Row label="Transaction ID" value={donation.razorpayPaymentId} />
            )}
            <Row label="Payment Method" value="Online (Razorpay)" />
          </dl>
        </div>

        {/* 80G section */}
        {receipt.is80G && cd?.taxConfig && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="mb-3 flex items-center gap-2">
              <Shield className="size-4 text-emerald-700" aria-hidden />
              <h2 className="text-sm font-semibold text-emerald-800">
                80G Tax Exemption Applicable
              </h2>
            </div>
            <dl className="divide-y divide-emerald-100 text-sm">
              {cd.taxConfig.organizationPan && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-emerald-700">NGO / Org PAN</dt>
                  <dd className="font-mono font-medium text-emerald-900">
                    {cd.taxConfig.organizationPan.toUpperCase()}
                  </dd>
                </div>
              )}
              {cd.taxConfig.registrationNumber && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-emerald-700">80G Registration No.</dt>
                  <dd className="font-medium text-emerald-900">
                    {cd.taxConfig.registrationNumber}
                  </dd>
                </div>
              )}
              {cd.taxConfig.certificateExpiry && (
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-emerald-700">Certificate Valid Until</dt>
                  <dd className="font-medium text-emerald-900">
                    {new Date(cd.taxConfig.certificateExpiry + 'T00:00:00')
                      .toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-3 text-xs text-emerald-700">
              This donation qualifies for a deduction under Section 80G of the Income Tax
              Act, 1961. Retain this receipt for your tax filing. Deduction amounts vary
              based on the applicable sub-section.
            </p>
          </div>
        )}

        {/* Download */}
        <div className="mt-6">
          <a
            href={downloadUrl}
            download
            className={cn(
              buttonVariants({ variant: 'primary' }),
              'w-full gap-2 py-3',
            )}
          >
            <Download className="size-4" aria-hidden />
            Download PDF Receipt
          </a>
        </div>

        {/* Legal */}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          This is a computer-generated receipt. Powered by RegisterDesk.
        </p>
      </div>
    </div>
  )
}
