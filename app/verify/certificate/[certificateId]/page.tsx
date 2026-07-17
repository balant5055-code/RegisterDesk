// /verify/certificate/[certificateId]
//
// Public certificate verification page. Accessible to anyone with the URL.
// Server-rendered. States: valid | revoked | not_found | disabled.
//
// Privacy: only non-sensitive fields are shown (id, participant, event, type,
// issue date, issuer), gated by the organizer's verification settings.

import type { Metadata } from 'next'
import Link              from 'next/link'
import { verifyCertificate } from '@/lib/certificates/verify'

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
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export default async function VerifyCertificatePage({ params }: PageProps) {
  const { certificateId } = await params
  const result = await verifyCertificate(certificateId)
  const c      = result.certificate

  return (
    <div className="min-h-screen bg-[#f7f8fa] font-sans">
      {/* Header */}
      <div className="border-b border-border bg-white px-4 py-3">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <Link href="/" className="text-[13px] font-bold text-foreground">RegisterDesk</Link>
          <span className="text-[12px] text-muted-foreground">Certificate Verification</span>
        </div>
      </div>

      <div className="mx-auto max-w-md px-4 py-12">
        <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-md">

          {/* ── Banner ─────────────────────────────────────────────────────── */}
          {result.state === 'valid' && (
            <Banner
              tone="emerald"
              icon="check"
              title="Certificate is Valid"
              subtitle="This certificate has been verified as authentic."
            />
          )}
          {result.state === 'revoked' && (
            <Banner
              tone="amber"
              icon="warn"
              title="Certificate Revoked"
              subtitle="This certificate has been revoked by the issuer and is no longer valid."
            />
          )}
          {result.state === 'not_found' && (
            <Banner
              tone="red"
              icon="cross"
              title="Certificate Not Found"
              subtitle="This certificate could not be verified. It may be invalid or the ID may be incorrect."
            />
          )}
          {result.state === 'disabled' && (
            <Banner
              tone="slate"
              icon="info"
              title="Verification Unavailable"
              subtitle="Public verification has been turned off for this certificate by the issuer."
            />
          )}

          {/* ── Details (valid / revoked) ───────────────────────────────────── */}
          {c && (result.state === 'valid' || result.state === 'revoked') && (
            <div className="divide-y divide-border px-6 py-2">
              <DetailRow label="Certificate ID" value={c.certificateId} mono />
              {c.participantName      && <DetailRow label="Participant"      value={c.participantName} />}
              {c.eventName            && <DetailRow label="Event"            value={c.eventName} />}
              {c.certificateTypeLabel && <DetailRow label="Type"             value={c.certificateTypeLabel} />}
              {c.issueDateIso         && <DetailRow label="Issued On"        value={fmtDate(c.issueDateIso)} />}
              {result.state === 'revoked' && c.revokedAtIso &&
                <DetailRow label="Revoked On" value={fmtDate(c.revokedAtIso)} />}
              {result.state === 'revoked' && c.revokeReason &&
                <DetailRow label="Reason" value={c.revokeReason} />}
            </div>
          )}

          {/* ── Issuer footer (valid / revoked) ─────────────────────────────── */}
          {c && (result.state === 'valid' || result.state === 'revoked') && (
            <div className="border-t border-border bg-muted/20 px-6 py-4 text-center">
              <p className="text-[11px] text-muted-foreground">
                Issued by <span className="font-semibold text-foreground">{c.issuer ?? 'RegisterDesk'}</span>
              </p>
            </div>
          )}

          {/* ── Bare id (not found / disabled) ──────────────────────────────── */}
          {(result.state === 'not_found' || result.state === 'disabled') && (
            <div className="px-6 py-5 text-center">
              <p className="text-[12px] text-muted-foreground">
                Certificate ID: <span className="font-mono text-foreground">{result.certificateId}</span>
              </p>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-[12px] text-muted-foreground">
          Powered by{' '}
          <Link href="/" className="font-semibold text-foreground hover:underline">RegisterDesk</Link>
        </p>
      </div>
    </div>
  )
}

// ─── Presentational components ──────────────────────────────────────────────

const TONES = {
  emerald: { bg: 'bg-emerald-50', chip: 'bg-emerald-100', icon: 'text-emerald-600', title: 'text-emerald-800', sub: 'text-emerald-600' },
  amber:   { bg: 'bg-amber-50',   chip: 'bg-amber-100',   icon: 'text-amber-600',   title: 'text-amber-800',   sub: 'text-amber-600' },
  red:     { bg: 'bg-red-50',     chip: 'bg-red-100',     icon: 'text-red-600',     title: 'text-red-800',     sub: 'text-red-600' },
  slate:   { bg: 'bg-slate-50',   chip: 'bg-slate-100',   icon: 'text-slate-600',   title: 'text-slate-800',   sub: 'text-slate-500' },
} as const

const ICON_PATHS = {
  check: 'M4.5 12.75l6 6 9-13.5',
  cross: 'M6 18L18 6M6 6l12 12',
  warn:  'M12 9v3.75m0 3.75h.008M10.34 3.94l-7.5 13A1.5 1.5 0 004.14 19h15.72a1.5 1.5 0 001.3-2.06l-7.5-13a1.5 1.5 0 00-2.62 0z',
  info:  'M11.25 11.25h1.5v5.25m-1.5 0h3M12 7.5h.008v.008H12V7.5z',
} as const

function Banner({
  tone, icon, title, subtitle,
}: {
  tone: keyof typeof TONES
  icon: keyof typeof ICON_PATHS
  title: string
  subtitle: string
}) {
  const t = TONES[tone]
  return (
    <div className={`flex items-center gap-3 px-6 py-4 ${t.bg}`}>
      <div className={`flex size-10 shrink-0 items-center justify-center rounded-full ${t.chip}`}>
        <svg className={`size-5 ${t.icon}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[icon]} />
        </svg>
      </div>
      <div>
        <p className={`text-[14px] font-bold ${t.title}`}>{title}</p>
        <p className={`text-[12px] ${t.sub}`}>{subtitle}</p>
      </div>
    </div>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-4 py-3.5">
      <p className="w-28 shrink-0 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`text-[13.5px] font-medium text-foreground ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  )
}
