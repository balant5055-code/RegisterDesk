'use client'

import { useState, useEffect }     from 'react'
import { useRouter }               from 'next/navigation'
import { useAuth }                 from '@/components/auth/AuthProvider'
import { Award, Download, Mail, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import type {
  OrganizerCertificatesResponse,
} from '@/app/api/organizer/certificates/route'

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function StatCard({
  label, value, icon: Icon, color,
}: {
  // RD-CERT-02 · a string, because an unread aggregate renders as an em dash.
  label: string; value: number | string; icon: React.ElementType; color: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-foreground/70" aria-hidden />
      </div>
      <div>
        <p className="text-[20px] font-bold leading-none text-foreground">{value}</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export default function CertificatesDashboardPage() {
  const router = useRouter()

  const [data,    setData]    = useState<OrganizerCertificatesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const { user, getToken } = useAuth()

  useEffect(() => {
    if (user === undefined) return
    let cancelled = false
    const run = async () => {
      if (!user) { setLoading(false); return }
      try {
        const token = await getToken()
        if (cancelled || !token) return
        const res   = await fetch('/api/organizer/certificates', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load certificates')
        if (cancelled) return
        setData(await res.json() as OrganizerCertificatesResponse)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load certificates')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [user, getToken])

  const certs = data?.certificates ?? []

  /**
   * RD-CERT-02 · these three were counted in the browser — `certs.length` and
   * `certs.filter(...).length` — over a 100-row page of the LEGACY collection. So they
   * were capped at 100 AND read 0 on any modern event, because the engine stopped
   * writing there. They are server-side aggregates over the whole workspace now.
   *
   * A figure the server could not read arrives null and renders as an em dash, never 0.
   */
  const fmt = (n: number | null | undefined) =>
    typeof n === 'number' ? n.toLocaleString('en-IN') : '—'
  const generated  = fmt(data?.counts?.generated)
  const downloaded = fmt(data?.counts?.downloads)
  const emailed    = fmt(data?.counts?.emailed)

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-[32px] font-bold text-foreground">Certificates</h1>
        <p className="mt-0.5 text-[14px] text-muted-foreground">
          All certificates generated across your events.
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Total Generated"  value={generated}  icon={Award}    color="bg-primary/[0.08]" />
            <StatCard label="Downloads"         value={downloaded} icon={Download} color="bg-emerald-100"   />
            <StatCard label="Emailed"           value={emailed}    icon={Mail}     color="bg-blue-100"      />
          </div>

          {/* Certificates table */}
          {certs.length > 0 ? (
            <div>
              <h2 className="mb-3 text-[18px] font-semibold text-foreground">All Certificates</h2>
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="overflow-x-auto">
                  <table className="w-full text-[14px]">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Attendee</th>
                        <th className="hidden px-4 py-2.5 text-left font-semibold text-muted-foreground lg:table-cell">Event</th>
                        <th className="hidden px-4 py-2.5 text-left font-semibold text-muted-foreground sm:table-cell">Certificate ID</th>
                        <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Issued</th>
                        <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground">Downloads</th>
                        <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground">Email</th>
                        <th className="px-4 py-2.5 text-right font-semibold text-muted-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {certs.map(cert => (
                        <tr key={cert.certificateId} className="hover:bg-muted/20">
                          <td className="px-4 py-3">
                            <p className="font-medium text-foreground">{cert.attendeeName}</p>
                            <p className="text-[13px] text-muted-foreground">{cert.attendeeEmail}</p>
                          </td>
                          <td className="hidden px-4 py-3 lg:table-cell">
                            <p className="text-foreground">{cert.eventName}</p>
                            <button
                              type="button"
                              onClick={() => router.push(`/dashboard/events/${cert.eventId}`)}
                              className="text-[13px] text-primary hover:underline"
                            >
                              Manage event
                            </button>
                          </td>
                          <td className="hidden px-4 py-3 sm:table-cell">
                            <span className="font-mono text-[12px] text-muted-foreground">{cert.certificateId}</span>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {cert.generatedAt ? fmtDate(cert.generatedAt) : "—"}
                          </td>
                          <td className="px-4 py-3 text-center text-muted-foreground">
                            {cert.downloadCount}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {cert.emailStatus === 'sent'
                              ? <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">Sent</span>
                              : cert.emailStatus === 'failed'
                                ? <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[12px] font-semibold text-red-700">Failed</span>
                                : <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[12px] font-semibold text-muted-foreground">—</span>
                            }
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-2">
                              {/* RD-CERT-02 · `/api/certificates/{id}` reads the LEGACY
                                  collection and 404s on anything the modern engine
                                  produced. This table now lists modern certificates, so
                                  the link had to move with it: `/file` is the same
                                  capability model over the authoritative store, and it
                                  is what serves the R2 artifact. */}
                              <a
                                href={`/api/certificates/${cert.certificateId}/file`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
                              >
                                <Download className="size-3" />
                                PDF
                              </a>
                              <a
                                href={`/verify/certificate/${cert.certificateId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
                              >
                                <ExternalLink className="size-3" />
                                Verify
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
              <Award className="size-10 text-muted-foreground/30" aria-hidden />
              <p className="text-[15px] font-semibold text-foreground">No certificates yet</p>
              <p className="max-w-xs text-[13px] text-muted-foreground">
                Enable certificates in an event&apos;s Certificates tab, then generate them for your attendees.
              </p>
              <button
                type="button"
                onClick={() => router.push('/dashboard/events')}
                className="mt-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-white hover:opacity-90"
              >
                Go to Events
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
