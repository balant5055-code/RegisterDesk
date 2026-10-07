'use client'

import { useEffect, useState } from 'react'
import { Upload, PenSquare, Award, QrCode } from 'lucide-react'
import { Spinner, ErrorBox, StatCard, btnGhost } from './ui'
import { buildCertificateOverview, cellText, type CertificateOverview } from '@/lib/certificates/report'
import type { CertApi, HubTab } from './api'
import { CertificateQrDialog } from './CertificateQrDialog'
import ExportZipPanel from './ExportZipPanel'

/** Public origin for the QR. Literal read so Next inlines it into the client bundle;
 *  falls back to the current origin in dev if the variable is unset. */
function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/+$/, '')
  return typeof window !== 'undefined' ? window.location.origin : ''
}

export default function OverviewPanel({ api, onNav, eventSlug }: {
  api: CertApi
  onNav: (t: HubTab) => void
  /** Public event slug. Absent until the event is published — the QR action is hidden
   *  then, because an unpublished event has no public Certificate Center to point at. */
  eventSlug?: string | null
}) {
  const [qrOpen, setQrOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [stats, setStats] = useState<CertificateOverview | null>(null)

  /**
   * ═══ RD-CERT-01 · WHY THIS NO LONGER COUNTS AN ARRAY ═══════════════════════
   *
   * These five numbers were computed here, in the browser, from `api.getRecords()`
   * called with no arguments. That endpoint is cursor-paginated and defaults to 200,
   * so every card described ONE PAGE: an event with 1,024 certificates reported
   * "Total Certificates 200", and Reports — which reads server-side aggregates —
   * reported 1,024. Two surfaces, one collection, two different answers.
   *
   * They now come from the same aggregate payload Reports uses, so the workspace and
   * Reports cannot disagree. Two of the old calculations were also wrong on their own
   * terms, and are corrected in `buildCertificateOverview`:
   *
   *   • `generated` was `total − revoked`, which counted FAILED generations as
   *     successful certificates.
   *   • `emailed` was `emailStatus === 'sent'` alone, which drops `delivered` —
   *     a terminal success state the restore path already treats as emailed.
   */
  useEffect(() => {
    let on = true
    api.getStats()
      .then(({ current }) => {
        if (!on) return
        // The route's older top-level fields count the LEGACY collection the engine no
        // longer writes to. `current` is the authoritative store; nothing else is read.
        if (!current) { setErr('Certificate statistics are unavailable.'); return }
        setStats(buildCertificateOverview(current))
      })
      .catch(e => on && setErr(e.message))
      .finally(() => on && setLoading(false))
    return () => { on = false }
  }, [api])

  if (loading) return <Spinner />
  if (err) return <ErrorBox message={err} />
  // No payload at all. Individual figures inside it may still be unknown, and those
  // render as an em dash — a card must never fall back to 0.
  if (!stats) return <ErrorBox message="Certificate statistics are unavailable." />

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total Certificates" value={cellText(stats.total)} />
        <StatCard label="Generated" value={cellText(stats.generated)} />
        <StatCard label="Emailed" value={cellText(stats.emailed)} />
        <StatCard label="Revoked" value={cellText(stats.revoked)} />
        <StatCard label="Downloads" value={cellText(stats.downloads)} />
      </div>

      <div>
        <h3 className="mb-3 text-[14px] font-semibold text-foreground">Quick actions</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnGhost} onClick={() => onNav('templates')}><Upload className="size-3.5" /> Upload Template</button>
          <button type="button" className={btnGhost} onClick={() => onNav('templates')}><PenSquare className="size-3.5" /> Open Builder</button>
          <button type="button" className={btnGhost} onClick={() => onNav('issue')}><Award className="size-3.5" /> Generate Certificates</button>
          {eventSlug && (
            <button type="button" className={btnGhost} onClick={() => setQrOpen(true)}><QrCode className="size-3.5" /> Certificate Download QR</button>
          )}
        </div>
      </div>

      {/* Bulk export lives beside the quick actions because it IS one — it just has a
          result worth showing (several parts) rather than a single file to hand back. */}
      <ExportZipPanel api={api} />

      {eventSlug && (
        <CertificateQrDialog
          open={qrOpen}
          onClose={() => setQrOpen(false)}
          url={`${appOrigin()}/events/${eventSlug}/certificates`}
        />
      )}
    </div>
  )
}
