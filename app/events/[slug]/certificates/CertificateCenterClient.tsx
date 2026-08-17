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

import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Search, Loader2, Award, Download, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import { AttendeePhotoCard } from '@/components/certificates/AttendeePhotoCard'

type Mode = 'email' | 'mobile' | 'registrationId' | 'bibNumber'

/**
 * The lookup modes, in display order. ONE table drives the selector, the field label, the
 * input's type/inputMode/autoComplete and its placeholder — so adding a mode is a single
 * row here rather than five parallel ternaries that can drift out of step.
 *
 * The key doubles as the request-body field name, which is what lets the request be built
 * as `{ [mode]: value }` and keeps the client from re-encoding the API's contract.
 */
const MODES: ReadonlyArray<{
  id:           Mode
  label:        string
  placeholder:  string
  type:         'email' | 'text' | 'tel'
  inputMode:    'email' | 'text' | 'tel' | 'numeric'
  autoComplete: string
}> = [
  { id: 'email',          label: 'Email Address',   placeholder: 'you@example.com', type: 'email', inputMode: 'email',   autoComplete: 'email' },
  { id: 'mobile',         label: 'Mobile Number',   placeholder: '98765 43210',     type: 'tel',   inputMode: 'tel',     autoComplete: 'tel'   },
  { id: 'registrationId', label: 'Registration ID', placeholder: 'e.g. 3f2c…',      type: 'text',  inputMode: 'text',    autoComplete: 'off'   },
  { id: 'bibNumber',      label: 'Bib Number',      placeholder: 'e.g. 1042',       type: 'text',  inputMode: 'numeric', autoComplete: 'off'   },
]

interface Result {
  participantName:    string
  certificateId:      string
  eventName:          string
  status:             string
  downloadCapability: string
}

/**
 * RD-CERT-PHOTO-02 — the photo flow for ONE certificate.
 *
 * Keyed by `certificateId` and never by list position: one email legitimately returns
 * several certificates (a parent who registered three children), and an index would hand a
 * sibling's grant to the wrong card the moment the list re-sorts or a search is repeated.
 */
interface PhotoState {
  /** Write credential for THIS certificate's photo. Scoped to one certificateId + event. */
  grant:          string
  /** Does the template actually have somewhere to put a photo? Server-resolved. */
  photoSupported: boolean
  /** Is a photo currently stored on this certificate? Decides which download URL is used. */
  hasPhoto:       boolean
}

/** The photo endpoint for one certificate. The card never builds this itself, so it can
 *  only ever address the certificate this page selected. */
function photoEndpoint(slug: string, certificateId: string): string {
  return `/api/events/${encodeURIComponent(slug)}/certificates/photo?certificateId=${encodeURIComponent(certificateId)}`
}

/**
 * Asks the server whether this certificate has a photo. Deliberately a server read rather
 * than something inferred from the card: the photo is persisted on the certificate, so a
 * returning attendee already has one before any upload happens in this session.
 *
 * Never throws — a failed probe reads as "no photo", which selects the ordinary download.
 */
async function readHasPhoto(slug: string, certificateId: string, grant: string): Promise<boolean> {
  try {
    const res = await fetch(photoEndpoint(slug, certificateId), {
      headers: { 'X-Certificate-Grant': grant },
    })
    if (!res.ok) return false
    const body = await res.json() as { hasPhoto?: boolean }
    return !!body.hasPhoto
  } catch {
    return false
  }
}

const inputCls =
  'h-12 w-full rounded-xl border border-border bg-card px-4 text-fs-sm text-foreground ' +
  'placeholder:text-muted-foreground/70 transition-colors ' +
  'focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:opacity-60'

export function CertificateCenterClient({ slug, eventName }: { slug: string; eventName: string }) {
  const reduce = useReducedMotion()
  const [mode,    setMode]    = useState<Mode>('email')
  // Non-null by construction: `mode` is only ever set from MODES.
  const active = MODES.find(m => m.id === mode) ?? MODES[0]
  const [value,   setValue]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  // Guards against a second in-flight request when the CTA is double-tapped. The disabled
  // attribute alone is not enough: a fast double-tap can land both clicks before React
  // has re-rendered with the new state.
  const inFlight = useRef(false)
  const resultsRef = useRef<HTMLDivElement>(null)
  // Photo flow state, one entry per certificateId. Absent ⇒ no session yet (or it failed),
  // in which case the card is simply not offered and the ordinary download is used.
  const [photo, setPhoto] = useState<Record<string, PhotoState>>({})
  // Certificates whose session has already been requested. A Set rather than a flag because
  // several certificates are minted concurrently, and `photo` alone cannot express
  // "requested but not yet answered" — which is exactly when a re-render would fire a
  // duplicate POST.
  const sessions = useRef<Set<string>>(new Set())

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault()
    const q = value.trim()
    if (!q || inFlight.current) return

    inFlight.current = true
    setBusy(true); setError(null); setResults(null)
    // A new search returns a different set of certificates, so the previous grants and
    // photo answers no longer describe anything on screen. Cleared together with the
    // results they belonged to.
    setPhoto({}); sessions.current.clear()
    try {
      // Exactly one mode, and never the slug — the API derives the event from the URL,
      // which is what makes cross-event lookup impossible from the client.
      const res  = await fetch(`/api/events/${encodeURIComponent(slug)}/certificates/lookup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // The mode key IS the API's field name, so exactly one field is ever sent — which
        // is what the server's "exactly one mode" guard expects.
        body:    JSON.stringify({ [mode]: q }),
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

  // ── Photo sessions, one per certificate in the current results ──────────────
  //
  // A grant is minted per certificate because `photoSupported` and the write credential BOTH
  // come from that mint — the client cannot know whether to offer an upload until the server
  // has resolved this certificate's template. The registrationId the grant is bound to is
  // resolved server-side from the certificate record and never sent here.
  //
  // Everything is per-certificate and failure-isolated: a rejected mint leaves that one card
  // without a photo section and changes nothing else on the page. The lookup results, the
  // download links and the verify links do not depend on any of this.
  //
  // The async work lives INSIDE the effect, matching AttendeePhotoCard and the rest of the
  // repo: every setState lands after an await, on a later tick.
  useEffect(() => {
    if (!results || results.length === 0) return
    let cancelled = false

    const open = async (certificateId: string) => {
      if (sessions.current.has(certificateId)) return
      sessions.current.add(certificateId)
      try {
        const res = await fetch(`/api/events/${encodeURIComponent(slug)}/certificates/photo/session`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ certificateId }),
        })
        if (!res.ok) return
        const body = await res.json() as { grant?: string; photoSupported?: boolean }
        if (cancelled || !body.grant) return

        const entry: PhotoState = {
          grant:          body.grant,
          photoSupported: !!body.photoSupported,
          hasPhoto:       false,
        }
        setPhoto(prev => ({ ...prev, [certificateId]: entry }))

        // Only worth asking when the template could print it.
        if (!entry.photoSupported) return
        const has = await readHasPhoto(slug, certificateId, entry.grant)
        if (cancelled || !has) return
        setPhoto(prev => (prev[certificateId] ? { ...prev, [certificateId]: { ...prev[certificateId], hasPhoto: true } } : prev))
      } catch {
        // Deliberately swallowed: the certificate list must survive a photo-service outage.
      }
    }

    void Promise.all(results.map(r => open(r.certificateId)))
    return () => { cancelled = true }
  }, [results, slug])

  /** Re-reads the stored photo after the attendee says they are done with the card. This is
   *  what moves the download button onto the personalized URL (and back off it after a
   *  removal) without AttendeePhotoCard needing to report anything upward. */
  async function refreshHasPhoto(certificateId: string, grant: string) {
    const has = await readHasPhoto(slug, certificateId, grant)
    setPhoto(prev => (prev[certificateId] ? { ...prev, [certificateId]: { ...prev[certificateId], hasPhoto: has } } : prev))
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
        {/* Two columns still, so four options stack 2×2 rather than squeezing onto one row
            on a phone — the same control height and touch target as before. */}
        <div role="radiogroup" aria-label="Look up by" className="mb-4 grid grid-cols-2 gap-2">
          {MODES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => { setMode(id); setValue(''); setResults(null); setError(null) }}
              className={cn(
                'h-11 rounded-xl border text-fs-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
                mode === id
                  ? 'border-primary/30 bg-[rgb(var(--primary-rgb)_/_0.06)] text-foreground'
                  : 'border-border bg-muted/25 text-muted-foreground hover:bg-muted/45',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <label htmlFor="cc-input" className="mb-1.5 block text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {active.label}
        </label>
        <input
          id="cc-input"
          className={inputCls}
          type={active.type}
          inputMode={active.inputMode}
          autoComplete={active.autoComplete}
          placeholder={active.placeholder}
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
                {results.map(r => {
                  const p = photo[r.certificateId]
                  // The personalized endpoint applies EVERY gate the artifact endpoint does
                  // and carries the SAME short-lived capability — it is a second door to the
                  // same room, not a wider one. It is chosen only when a photo actually
                  // exists; without one the original URL is used, untouched. Should this
                  // state ever be stale, the personalized route falls back to the stored
                  // artifact, so the attendee always gets their certificate.
                  const downloadHref = p?.hasPhoto
                    ? `/api/certificates/${encodeURIComponent(r.certificateId)}/file/personalized?token=${encodeURIComponent(r.downloadCapability)}`
                    : `/api/certificates/${encodeURIComponent(r.certificateId)}/file?token=${encodeURIComponent(r.downloadCapability)}`

                  return (
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

                    {/* Photo, per certificate — never page-level. The section appears only
                        when the server confirmed this certificate's template has a photo
                        area, so an attendee is never offered an upload that could not
                        appear on their PDF. */}
                    {p?.photoSupported && (
                      <div className="border-t border-border/60 px-5 py-4">
                        <AttendeePhotoCard
                          endpoint={photoEndpoint(slug, r.certificateId)}
                          grant={p.grant}
                          description="This event’s certificate has a photo area. Add your picture and it appears on the certificate you download."
                          onContinue={() => { void refreshHasPhoto(r.certificateId, p.grant) }}
                          className="rounded-none border-0 bg-transparent p-0 sm:p-0"
                        />
                      </div>
                    )}

                    <div className="flex flex-col gap-2 border-t border-border/60 px-5 py-3.5 sm:flex-row-reverse">
                      {/* The capability is short-lived and lives only in this URL — never
                          persisted, so a refresh cannot resurrect it. */}
                      <a
                        href={downloadHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-h-12 flex-1 gap-2')}
                      >
                        <Download className="size-4" aria-hidden />
                        Download Certificate
                      </a>
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
                  )
                })}
              </ul>
            </>
          )}
        </motion.div>
      )}
    </div>
  )
}
