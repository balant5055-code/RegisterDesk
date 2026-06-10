// /verify/certificate/[certificateId]
//
// Public certificate verification page. Accessible to anyone with the URL.
// Server-rendered for instant load and SEO-friendliness.

import type { Metadata }  from 'next'
import Link               from 'next/link'
import { getCertificateById } from '@/lib/certificates/firestore'
import { isValidCertificateId } from '@/lib/certificates/id'

type PageProps = { params: Promise<{ certificateId: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { certificateId } = await params
  return {
    title:       `Verify Certificate ${certificateId} – RegisterDesk`,
    description: 'Verify the authenticity of a RegisterDesk certificate.',
    robots:      { index: false, follow: false },
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export default async function VerifyCertificatePage({ params }: PageProps) {
  const { certificateId } = await params

  const valid  = isValidCertificateId(certificateId)
  const record = valid ? await getCertificateById(certificateId) : null

  const issueDateIso = record ? toISO(record.issuedAt) : null

  return (
    <div className="min-h-screen bg-[#f7f8fa] font-sans">

      {/* Header */}
      <div className="border-b border-border bg-white px-4 py-3">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <Link href="/" className="text-[13px] font-bold text-foreground">
            RegisterDesk
          </Link>
          <span className="text-[12px] text-muted-foreground">Certificate Verification</span>
        </div>
      </div>

      <div className="mx-auto max-w-md px-4 py-12">

        {record ? (
          /* ── Valid certificate ─────────────────────────────────────────── */
          <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-md">

            {/* Green valid banner */}
            <div className="flex items-center gap-3 bg-emerald-50 px-6 py-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                <svg className="size-5 text-emerald-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <div>
                <p className="text-[14px] font-bold text-emerald-800">Certificate is Valid</p>
                <p className="text-[12px] text-emerald-600">This certificate has been verified as authentic.</p>
              </div>
            </div>

            {/* Details */}
            <div className="divide-y divide-border px-6 py-2">
              <DetailRow label="Certificate ID" value={record.certificateId} mono />
              <DetailRow label="Participant"    value={record.attendeeName} />
              <DetailRow label="Event"          value={record.eventName} />
              {record.eventDate && <DetailRow label="Event Date" value={record.eventDate} />}
              {issueDateIso && <DetailRow label="Issued On" value={fmtDate(issueDateIso)} />}
            </div>

            {/* Issued by */}
            <div className="border-t border-border bg-muted/20 px-6 py-4 text-center">
              <p className="text-[11px] text-muted-foreground">
                Issued by <span className="font-semibold text-foreground">RegisterDesk</span>
              </p>
            </div>
          </div>
        ) : (
          /* ── Invalid / not found ──────────────────────────────────────── */
          <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-md">
            <div className="flex items-center gap-3 bg-red-50 px-6 py-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg className="size-5 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <div>
                <p className="text-[14px] font-bold text-red-800">Certificate Not Found</p>
                <p className="text-[12px] text-red-600">
                  This certificate could not be verified. It may be invalid or the ID may be incorrect.
                </p>
              </div>
            </div>

            <div className="px-6 py-5 text-center">
              <p className="text-[12px] text-muted-foreground">
                Certificate ID: <span className="font-mono text-foreground">{certificateId}</span>
              </p>
            </div>
          </div>
        )}

        <p className="mt-6 text-center text-[12px] text-muted-foreground">
          Powered by{' '}
          <Link href="/" className="font-semibold text-foreground hover:underline">
            RegisterDesk
          </Link>
        </p>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start gap-4 py-3.5">
      <p className="w-28 shrink-0 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`text-[13.5px] font-medium text-foreground ${mono ? 'font-mono' : ''}`}>
        {value}
      </p>
    </div>
  )
}
