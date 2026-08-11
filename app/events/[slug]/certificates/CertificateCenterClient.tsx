'use client'

// Event Day Certificate Center — the attendee-facing front door behind the venue QR.
//
// The QR carries only the event slug, so this page is the entire identity step: an
// attendee types the email or registration id they registered with and gets back the
// certificates for THIS event. One email legitimately maps to several participants (a
// parent who registered three children), so the participant NAME is the dominant element
// on each card and nothing is ever downloaded automatically — the attendee chooses.
//
// Everything shown here comes from the lookup API's five-field projection. No private
// field is available to this component even if it wanted one.

import { useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Search, Loader2, Award, Download, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'

type Mode = 'email' | 'registrationId'

interface Result {
  participantName:    string
  certificateId:      string
  eventName:          string
  status:             string
  downloadCapability: string
}

const inputCls =
  'h-12 w-full rounded-xl border border-border bg-card px-4 text-fs-sm text-foreground ' +
  'placeholder:text-muted-foreground/70 transition-colors ' +
  'focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:opacity-60'

export function CertificateCenterClient({ slug, eventName }: { slug: string; eventName: string }) {
  const reduce = useReducedMotion()
  const [mode,    setMode]    = useState<Mode>('email')
  const [value,   setValue]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  // Guards against a second in-flight request when the CTA is double-tapped. The disabled
  // attribute alone is not enough: a fast double-tap can land both clicks before React
  // has re-rendered with the new state.
  const inFlight = useRef(false)
  const resultsRef = useRef<HTMLDivElement>(null)

  // ── On-demand certificate download ─────────────────────────────────────────
  // `downloading` holds the certificateId being prepared: it drives the per-row spinner,
  // disables EVERY download button (one render at a time), and opens the modal.
  const [downloading,  setDownloading]  = useState<string | null>(null)
  const [downloadDone, setDownloadDone] = useState(false)
  const [downloadErr,  setDownloadErr]  = useState(false)
  // Same reasoning as `inFlight` above — a double-tap can beat the re-render.
  const downloadInFlight = useRef(false)

  /** Reads the server's filename so the saved file matches Content-Disposition. */
  function filenameFrom(header: string | null, fallback: string): string {
    const m = header && /filename="([^"]+)"/.exec(header)
    return m ? m[1] : fallback
  }

  async function downloadCertificate(certificateId: string, capability: string) {
    if (downloadInFlight.current) return
    downloadInFlight.current = true
    setDownloading(certificateId)
    setDownloadDone(false)
    setDownloadErr(false)

    let objectUrl: string | null = null
    try {
      const res = await fetch(
        `/api/certificates/${encodeURIComponent(certificateId)}/file?token=${encodeURIComponent(capability)}`,
      )
      if (!res.ok) throw new Error(String(res.status))

      const blob = await res.blob()
      objectUrl = URL.createObjectURL(blob)

      // Anchor + download attribute rather than window.open: it keeps the attendee on the
      // page and works on Android Chrome, desktop Chrome/Edge and iOS Safari (14.5+),
      // where a programmatic window.open is frequently blocked after an await.
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filenameFrom(res.headers.get('content-disposition'), `certificate-${certificateId}.pdf`)
      document.body.appendChild(a)
      a.click()
      a.remove()

      setDownloadDone(true)
      window.setTimeout(() => setDownloadDone(false), 2500)
    } catch {
      // Never surface the server's message — it can carry gating detail.
      setDownloadErr(true)
    } finally {
      // Revoked on the next tick: revoking synchronously can cancel the download on Safari.
      const toRevoke = objectUrl
      if (toRevoke) window.setTimeout(() => URL.revokeObjectURL(toRevoke), 60_000)
      setDownloading(null)
      downloadInFlight.current = false
    }
  }

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault()
    const q = value.trim()
    if (!q || inFlight.current) return

    inFlight.current = true
    setBusy(true); setError(null); setResults(null)
    try {
      // Exactly one mode, and never the slug — the API derives the event from the URL,
      // which is what makes cross-event lookup impossible from the client.
      const res  = await fetch(`/api/events/${encodeURIComponent(slug)}/certificates/lookup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(mode === 'email' ? { email: q } : { registrationId: q }),
      })
      const body = await res.json().catch(() => null) as { results?: Result[]; error?: string } | null

      if (res.status === 429) { setError('Too many attempts. Please wait a moment and try again.'); return }
      if (!res.ok)            { setError(body?.error ?? 'Something went wrong. Please try again.'); return }

      setResults(body?.results ?? [])
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const count = results?.length ?? 0

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgb(var(--primary-rgb)_/_0.08)] px-3 py-1 text-fs-2xs font-bold uppercase tracking-[0.14em] text-primary">
          <Award className="size-3.5" aria-hidden /> Certificate Center
        </span>
        <h1 className="mt-4 text-fs-2xl font-bold tracking-tight text-foreground">
          Download Your Certificate
        </h1>
        <p className="mt-2 text-fs-md font-semibold text-foreground">{eventName}</p>
        <p className="mx-auto mt-2 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
          Enter the email address or registration ID you used to register.
        </p>
      </div>

      {/* ── Lookup ─────────────────────────────────────────────────────────── */}
      <form onSubmit={lookup} autoComplete="off" className="mt-8 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div role="radiogroup" aria-label="Look up by" className="mb-4 grid grid-cols-2 gap-2">
          {([['email', 'Email Address'], ['registrationId', 'Registration ID']] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => { setMode(m); setValue(''); setResults(null); setError(null) }}
              className={cn(
                'h-11 rounded-xl border text-fs-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
                mode === m
                  ? 'border-primary/30 bg-[rgb(var(--primary-rgb)_/_0.06)] text-foreground'
                  : 'border-border bg-muted/25 text-muted-foreground hover:bg-muted/45',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <label htmlFor="cc-input" className="mb-1.5 block text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {mode === 'email' ? 'Email Address' : 'Registration ID'}
        </label>
        <input
          id="cc-input"
          className={inputCls}
          type={mode === 'email' ? 'email' : 'text'}
          inputMode={mode === 'email' ? 'email' : 'text'}
          autoComplete={mode === 'email' ? 'email' : 'off'}
          placeholder={mode === 'email' ? 'you@example.com' : 'e.g. 3f2c…'}
          value={value}
          disabled={busy}
          onChange={e => setValue(e.target.value)}
        />

        <button
          type="submit"
          disabled={busy || !value.trim()}
          className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-4 w-full gap-2')}
        >
          {busy
            ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Searching…</>
            : <><Search className="size-4" aria-hidden /> Find My Certificate</>}
        </button>

        {/* Announced without stealing focus, so a screen-reader user hears the outcome
            while the caret stays in the field they were typing in. */}
        <p aria-live="polite" className="sr-only">
          {busy ? 'Searching for certificates' : results ? `${count} certificates found` : ''}
        </p>
      </form>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-fs-sm font-medium text-red-700">
          {error}
        </p>
      )}

      {/* ── Results ────────────────────────────────────────────────────────── */}
      {results && (
        <motion.div
          ref={resultsRef}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="mt-8"
        >
          {count === 0 ? (
            // Uniform wording — it must not reveal whether the identifier exists in some
            // other event, or exists here but was revoked.
            <div className="rounded-2xl border border-border bg-muted/20 px-5 py-8 text-center">
              <p className="text-fs-md font-semibold text-foreground">No certificate found for this event.</p>
              <p className="mt-1.5 text-fs-sm text-muted-foreground">
                Check the spelling, or try the other lookup option.
              </p>
            </div>
          ) : (
            <>
              <h2 className="mb-3 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {count === 1 ? '1 certificate found' : `${count} certificates found`}
              </h2>
              <ul className="space-y-3">
                {results.map(r => (
                  <li key={r.certificateId} className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                    <div className="px-5 py-4">
                      {/* Participant name is the dominant identity — with three siblings
                          on one email, this is the only thing that tells them apart. */}
                      <p className="text-fs-lg font-bold leading-snug text-foreground">{r.participantName}</p>
                      <p className="mt-0.5 text-fs-sm text-muted-foreground">{r.eventName}</p>
                      <p className="mt-1.5 font-mono text-fs-2xs uppercase tracking-wider text-muted-foreground">
                        {r.certificateId}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 border-t border-border/60 px-5 py-3.5 sm:flex-row-reverse">
                      {/* The capability is short-lived and lives only in this URL — never
                          persisted, so a refresh cannot resurrect it.

                          A button, not an anchor: the PDF is now rendered on demand, so
                          there is a real wait to represent. Fetch + blob also lets us use
                          the server's Content-Disposition filename and keeps the attendee
                          on this page — no blank tab, which is what a plain navigation to
                          a slow endpoint looks like on mobile. */}
                      <button
                        type="button"
                        onClick={() => downloadCertificate(r.certificateId, r.downloadCapability)}
                        disabled={!!downloading}
                        aria-busy={downloading === r.certificateId}
                        className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-h-12 flex-1 gap-2 disabled:opacity-60')}
                      >
                        {downloading === r.certificateId
                          ? <Loader2 className="size-4 animate-spin" aria-hidden />
                          : <Download className="size-4" aria-hidden />}
                        {downloading === r.certificateId ? 'Preparing…' : 'Download Certificate'}
                      </button>
                      <a
                        href={`/verify/certificate/${encodeURIComponent(r.certificateId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-h-12 flex-1 gap-2')}
                      >
                        <ExternalLink className="size-4" aria-hidden />
                        View Certificate
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </motion.div>
      )}

      {/* ── Preparing / done / failed ────────────────────────────────────────
          Rendering IS the wait, so the modal is honest about it: a spinner and no
          percentage, because there is no progress to report. Not dismissible while
          preparing — closing it would leave an in-flight request with nowhere to land. */}
      <Dialog
        open={!!downloading || downloadDone || downloadErr}
        onClose={() => { if (!downloading) { setDownloadDone(false); setDownloadErr(false) } }}
        closeOnBackdrop={!downloading}
        size="sm"
        title={downloadErr ? 'Unable to download certificate' : downloadDone ? 'Certificate downloaded' : 'Preparing your certificate'}
      >
        <div className="flex items-start gap-3 py-1">
          {downloading && <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />}
          {downloadDone && !downloading && <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />}
          {downloadErr && !downloading && <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
          <p className="text-fs-sm text-muted-foreground" role="status" aria-live="polite">
            {downloadErr
              ? 'Please try again.'
              : downloadDone
                ? 'Check your downloads for the PDF.'
                : 'Your certificate is being prepared. Please wait a moment…'}
          </p>
        </div>
      </Dialog>
    </div>
  )
}
