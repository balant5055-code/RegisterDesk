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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Search, Loader2, Award, Download, ExternalLink, Share2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import type { CertificateVerifyResponse } from '@/app/api/verify/certificate/[certificateId]/route'
import { buttonVariants } from '@/components/ui/button'
import { AttendeePhotoCard } from '@/components/certificates/AttendeePhotoCard'
import { applyPhotoBusy } from '@/lib/certificates/photoBusyState'

type Mode = 'email' | 'mobile' | 'ticketCode' | 'registrationId' | 'bibNumber'

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
  // The code printed on the ticket / encoded in the check-in QR. A DIFFERENT identifier from
  // the registration id below — attendees have the ticket code to hand, almost never the uuid.
  { id: 'ticketCode',     label: 'Ticket Code',     placeholder: 'RD-XXXXXXXX',     type: 'text',  inputMode: 'text',    autoComplete: 'off'   },
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
/**
 * Whether THIS certificate can be downloaded yet.
 *
 * THE RACE THIS CLOSES. `photoSupported` and `hasPhoto` both arrive asynchronously, and the
 * download URL depends on `hasPhoto`. While a photo was uploading, the button still pointed at
 * the ORIGINAL artifact — so a click mid-upload handed the attendee a certificate without the
 * photo they had just added, and it looked like the upload had failed. Download is therefore
 * gated on the photo state being RESOLVED, not merely on nothing being clicked.
 *
 *   'resolving'  — session in flight, or a photo write is in progress: the correct download
 *                  target is not yet known
 *   'ready'      — the target is known and correct (with or without a photo)
 *   'unavailable'— the session failed; the ordinary artifact is still offered
 */
type Readiness = 'resolving' | 'ready' | 'unavailable'

interface PhotoState {
  /** Write credential for THIS certificate's photo. Scoped to one certificateId + event. */
  grant:          string
  /** Does the template actually have somewhere to put a photo? Server-resolved. */
  photoSupported: boolean
  /** Is a photo currently stored on this certificate? Decides which download URL is used. */
  hasPhoto:       boolean
  /** Whether `hasPhoto` — and therefore the download target — can be trusted right now. */
  readiness:      Readiness
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
  /** Which action is in flight for a given certificate — also the duplicate-click guard.
   *  Per certificate, because a family sees several cards and one must not freeze the rest. */
  const [action,  setAction]  = useState<Record<string, 'pdf' | 'share' | null>>({})
  /** Inline per-card feedback. The public Center is outside the dashboard's ToastProvider,
   *  so results are shown in the card itself rather than through a toast that cannot mount. */
  const [actionMsg, setActionMsg] = useState<Record<string, { ok: boolean; text: string } | null>>({})
  /** The certificate whose verification details are open in the modal, or null. */
  const [viewing, setViewing] = useState<{ certificateId: string; participantName: string } | null>(null)
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
  /** Certificate ids with a download in flight. Synchronous twin of `action` — see downloadPdf. */
  const downloading = useRef<Set<string>>(new Set())

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
          // A template with no photo area is immediately settled: `hasPhoto` can never
          // become true, so the ordinary artifact is already the right target.
          readiness:      body.photoSupported ? 'resolving' : 'ready',
        }
        setPhoto(prev => ({ ...prev, [certificateId]: entry }))

        // Only worth asking when the template could print it.
        if (!entry.photoSupported) return
        const has = await readHasPhoto(slug, certificateId, entry.grant)
        if (cancelled) return
        // Settle in ONE update: `hasPhoto` and `readiness` must never be observed apart, or
        // the button would briefly be enabled while still pointing at the wrong URL.
        setPhoto(prev => (prev[certificateId]
          ? { ...prev, [certificateId]: { ...prev[certificateId], hasPhoto: has, readiness: 'ready' } }
          : prev))
      } catch {
        // Deliberately swallowed: the certificate list must survive a photo-service outage.
      }
    }

    void Promise.all(results.map(r => open(r.certificateId)))
    return () => { cancelled = true }
  }, [results, slug])

  /**
   * Downloads the certificate WITHOUT leaving the page.
   *
   * A plain `<a href>` navigated the tab to `/file`, which on a 302-to-R2 left the attendee
   * staring at a PDF viewer with no way back to their other certificates — and on mobile
   * looked like the photo section had "opened" something. Fetching the bytes and handing the
   * browser a blob keeps the Center mounted, so the photo card, the other certificates and
   * the lookup results all survive the download.
   *
   * Every server-side gate is unchanged: the same capability-bearing URL is requested, the
   * same route enforces revocation, download settings and the token. Nothing is exposed that
   * the anchor did not already expose — the signed storage URL stays inside `fetch`, and is
   * never put in the address bar.
   */
  async function downloadPdf(certificateId: string, href: string) {
    // DUPLICATE-CLICK GUARD — synchronous, because `action` is React state.
    //
    // `if (action[certificateId]) return` reads a value that only becomes true after a
    // re-render. Two taps in the same tick — which is what an impatient thumb on a slow venue
    // connection actually produces — both observe the stale falsy value, both pass, and the
    // attendee gets two fetches and two saved copies of the same PDF. The `disabled` prop has
    // the same lag for the same reason.
    //
    // This Set is written before the first `await`, so the second call returns immediately.
    // It is CLEARED in `finally` rather than held forever: the button must come back so a
    // failed or repeated download is still possible (that is the point of the restore below).
    // It guards concurrency, not repetition.
    if (downloading.current.has(certificateId)) return
    downloading.current.add(certificateId)

    setAction(a => ({ ...a, [certificateId]: 'pdf' }))
    setActionMsg(m => ({ ...m, [certificateId]: null }))

    let objectUrl: string | null = null
    try {
      const res = await fetch(href)
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? 'We could not prepare your certificate. Please try again.')
      }
      const blob = await res.blob()
      objectUrl = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `certificate-${certificateId}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()

      setActionMsg(m => ({ ...m, [certificateId]: { ok: true, text: 'Certificate downloaded.' } }))
    } catch (e) {
      setActionMsg(m => ({
        ...m,
        [certificateId]: { ok: false, text: e instanceof Error ? e.message : 'Download failed. Please try again.' },
      }))
    } finally {
      // Revoked on a later tick: Safari cancels an in-flight download if the blob URL is
      // released in the same task as the click.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 60_000)
      downloading.current.delete(certificateId)
      setAction(a => ({ ...a, [certificateId]: null }))
    }
  }

  /**
   * Shares the PUBLIC verification link — never a storage URL and never the download
   * capability, which is short-lived and would hand whoever received it the PDF itself.
   */
  async function shareCertificate(certificateId: string, participantName: string, eventTitle: string) {
    if (action[certificateId]) return
    const url = `${window.location.origin}/verify/certificate/${encodeURIComponent(certificateId)}`
    setAction(a => ({ ...a, [certificateId]: 'share' }))
    setActionMsg(m => ({ ...m, [certificateId]: null }))
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: `${participantName} — ${eventTitle}`, text: `${participantName}'s certificate`, url })
        return                                            // the sheet is its own confirmation
      }
      await navigator.clipboard.writeText(url)
      setActionMsg(m => ({ ...m, [certificateId]: { ok: true, text: 'Certificate link copied.' } }))
    } catch (e) {
      // A dismissed share sheet rejects with AbortError — that is a choice, not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') return
      setActionMsg(m => ({ ...m, [certificateId]: { ok: false, text: 'Could not share. Copy the link from the verification page instead.' } }))
    } finally {
      setAction(a => ({ ...a, [certificateId]: null }))
    }
  }

  /** Re-reads the stored photo after the attendee says they are done with the card. This is
   *  what moves the download button onto the personalized URL (and back off it after a
   *  removal). Download stays disabled for the whole round trip. */
  /** Mirrors `photo` so the stable callbacks below can read the CURRENT grant without
   *  taking `photo` as a dependency — which would churn their identity on every render and
   *  re-fire the card's effect (the render loop fixed in RD-CERT-PHOTO-BUSY). */
  const photoRef = useRef<Record<string, PhotoState>>({})
  useEffect(() => { photoRef.current = photo }, [photo])

  /** Certificates whose card has reported an IN-FLIGHT write. A busy=false report only means
   *  "finished" if we saw the matching busy=true — otherwise it is just the card mounting,
   *  and re-resolving there would fire a duplicate request per card at page load. */
  const writing = useRef<Set<string>>(new Set())

  // useCallback so the memoised busy handlers can DECLARE it as a dependency without their
  // identity churning every render — declaring a dep that is rebuilt each render would
  // re-fire the card's effect and resurrect the render loop. It closes over `slug` plus two
  // stable references (the ref and the setter), so [slug] is genuinely exhaustive.
  const refreshHasPhoto = useCallback(async (certificateId: string, grantArg?: string) => {
    const grant = grantArg ?? photoRef.current[certificateId]?.grant
    if (!grant) {
      // No credential ⇒ we can never resolve. Settle rather than leave the button stuck.
      setPhoto(prev => (prev[certificateId]
        ? { ...prev, [certificateId]: { ...prev[certificateId], readiness: 'ready' } }
        : prev))
      return
    }
    setPhoto(prev => (prev[certificateId]
      ? { ...prev, [certificateId]: { ...prev[certificateId], readiness: 'resolving' } }
      : prev))
    // Settled in `finally` so the guarantee is STRUCTURAL: there is no path out of this
    // function that leaves the button on "Getting ready…". readHasPhoto already swallows its
    // own errors, but relying on that would make the guarantee accidental rather than certain.
    let has = false
    try {
      has = await readHasPhoto(slug, certificateId, grant)
    } finally {
      setPhoto(prev => (prev[certificateId]
        ? { ...prev, [certificateId]: { ...prev[certificateId], hasPhoto: has, readiness: 'ready' } }
        : prev))
    }
  }, [slug])

  /**
   * The card reports upload/remove activity so the download target cannot be used while the
   * stored photo is changing underneath it — the exact race where a click mid-upload returned
   * the certificate WITHOUT the photo the attendee had just added.
   */
  // Stable for the component's lifetime: it closes over nothing but the `setPhoto` setter,
  // which React guarantees is stable. The transition itself lives in `applyPhotoBusy`, which
  // returns `prev` by reference when nothing actually changes — so a repeated report costs
  // no render. Both halves matter; see photoBusyState.ts for the loop they prevent.
  const setPhotoBusy = useCallback((certificateId: string, busy: boolean) => {
    setPhoto(prev => applyPhotoBusy(prev, certificateId, busy))
  }, [])

  /**
   * ONE stable `onBusyChange` per certificate.
   *
   * The previous call site built `busyNow => setPhotoBusy(r.certificateId, busyNow)` inline
   * inside the results map, so every render handed each card a brand-new function. The card
   * reports its busy state from an effect keyed on that callback, so a new identity re-fired
   * the effect on every render — the other half of the loop.
   *
   * Keyed by certificateId and rebuilt only when the RESULT SET changes (a new lookup), which
   * is exactly when a card can appear or disappear. Per-certificate keys are what keep the
   * cards independent: participant A's handler only ever names A's id.
   */
  const busyHandlers = useMemo(() => {
    const m = new Map<string, (busy: boolean) => void>()
    for (const r of results ?? []) {
      m.set(r.certificateId, (busy: boolean) => {
        if (busy) {
          writing.current.add(r.certificateId)
          setPhotoBusy(r.certificateId, true)
          return
        }
        // THE STUCK STATE. `applyPhotoBusy(…, false)` deliberately leaves `readiness`
        // untouched, so nothing here could ever move it off 'resolving' — the button read
        // "Getting ready…" forever once an upload finished, even on HTTP 200. Recovery used
        // to depend entirely on the attendee pressing "Continue".
        //
        // A write has finished, and the stored photo may have changed, so the download target
        // has to be re-read exactly once. Guarded by `writing` so a card merely mounting
        // (which also reports busy=false) does not fire a duplicate request.
        if (!writing.current.delete(r.certificateId)) return
        void refreshHasPhoto(r.certificateId)
      })
    }
    return m
  }, [results, setPhotoBusy, refreshHasPhoto])

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

                    {/* ── ACTIONS ─────────────────────────────────────────────────────
                        Pinned DIRECTLY under the certificate's identity and rendered BEFORE
                        the photo section, so they occupy a fixed position from first paint.
                        `photoSupported` resolves asynchronously; when the photo card used to
                        render ABOVE this row, its arrival pushed both buttons downward and a
                        tap already in flight landed on the newly-inserted photo area instead.
                        Nothing below can move them now, and no space has to be reserved — so
                        a certificate without a photo area shows no empty gap.

                        The two actions are independent anchors and must stay that way: no
                        shared handler, no parent onClick, no button/anchor nesting. View
                        navigates to verification and nothing else; it never downloads, never
                        mints a grant and never touches the download counter. */}
                    <div className="flex flex-col gap-2 border-t border-border/60 px-5 py-3.5 sm:flex-row">
                      {/* View first in the DOM AND first visually, at every breakpoint — the
                          row used to be `sm:flex-row-reverse`, which made reading order and
                          tab order disagree with the rendered order on desktop. */}
                      {/* Opens the verification details IN PLACE. A button, not a link: the
                          Center must stay mounted so the attendee keeps their results, their
                          photo section and their other certificates. It triggers no download
                          and never touches the capability token. */}
                      <button
                        type="button"
                        onClick={() => setViewing({ certificateId: r.certificateId, participantName: r.participantName })}
                        className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-h-12 flex-1 gap-2')}
                      >
                        <ExternalLink className="size-4" aria-hidden />
                        View Certificate
                      </button>
                      {/* DOWNLOAD IS A BUTTON, NOT A LINK. The capability is short-lived and
                          lives only in the fetched URL — never in the address bar, and never
                          persisted, so a refresh cannot resurrect it. Fetching keeps the
                          attendee on this page with their other certificates intact. */}
                      {/* Disabled until the photo state is RESOLVED — see Readiness. An
                          undefined entry means the session has not answered yet, which is
                          also "not ready". */}
                      <button
                        type="button"
                        disabled={!!action[r.certificateId] || !p || p.readiness === 'resolving'}
                        onClick={() => { void downloadPdf(r.certificateId, downloadHref) }}
                        className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'min-h-12 flex-1 gap-2')}
                      >
                        {action[r.certificateId] === 'pdf'
                          ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Preparing…</>
                          : (!p || p.readiness === 'resolving')
                            ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Getting ready…</>
                            : <><Download className="size-4" aria-hidden /> Download PDF</>}
                      </button>
                      <button
                        type="button"
                        disabled={!!action[r.certificateId]}
                        onClick={() => { void shareCertificate(r.certificateId, r.participantName, r.eventName) }}
                        className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-h-12 flex-1 gap-2')}
                      >
                        <Share2 className="size-4" aria-hidden />
                        Share
                      </button>
                    </div>

                    {/* Per-card result. Inline rather than a toast: this public page is not
                        inside the dashboard's ToastProvider. */}
                    {actionMsg[r.certificateId] && (
                      <p
                        role={actionMsg[r.certificateId]!.ok ? 'status' : 'alert'}
                        className={cn(
                          'px-5 pb-3 text-fs-2xs font-medium',
                          actionMsg[r.certificateId]!.ok ? 'text-emerald-600' : 'text-destructive',
                        )}
                      >
                        {actionMsg[r.certificateId]!.text}
                      </p>
                    )}

                    {/* Photo, per certificate — never page-level. The section appears only
                        when the server confirmed this certificate's template has a photo
                        area, so an attendee is never offered an upload that could not
                        appear on their PDF. Rendered AFTER the actions: its late arrival
                        extends the card downward instead of displacing the buttons. */}
                    {p?.photoSupported && (
                      <div className="border-t border-border/60 px-5 py-4">
                        <AttendeePhotoCard
                          endpoint={photoEndpoint(slug, r.certificateId)}
                          grant={p.grant}
                          description="This event’s certificate has a photo area. Add your picture and it appears on the certificate you download."
                          onContinue={() => { void refreshHasPhoto(r.certificateId, p.grant) }}
                          onBusyChange={busyHandlers.get(r.certificateId)}
                          className="rounded-none border-0 bg-transparent p-0 sm:p-0"
                        />
                      </div>
                    )}
                  </li>
                  )
                })}
              </ul>
            </>
          )}
        </motion.div>
      )}

      {viewing && (
        <VerifyDialog
          certificateId={viewing.certificateId}
          participantName={viewing.participantName}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

/**
 * Certificate verification, shown IN PLACE.
 *
 * Reuses the existing public endpoint `/api/verify/certificate/{id}` — the same read-only,
 * rate-limited, privacy-filtered source the standalone verification page consumes. Nothing
 * about certificate rendering is duplicated here: this shows the verification RESULT, exactly
 * the fields that endpoint already chooses to expose, and never the PDF, a storage URL or the
 * download capability.
 *
 * Escape-to-close and the focus trap come from the shared Dialog.
 */
function VerifyDialog({
  certificateId, participantName, onClose,
}: {
  certificateId:   string
  participantName: string
  onClose:         () => void
}) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [data,  setData]  = useState<CertificateVerifyResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const res = await fetch(`/api/verify/certificate/${encodeURIComponent(certificateId)}`)
        if (!res.ok) throw new Error('unavailable')
        const body = await res.json() as CertificateVerifyResponse
        if (cancelled) return
        setData(body); setState('ok')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    void run()
    return () => { cancelled = true }
  }, [certificateId])

  const rows: Array<[string, string | undefined]> = data ? [
    ['Certificate ID', data.certificateId],
    ['Participant',    data.participantName],
    ['Event',          data.eventName],
    ['Type',           data.certificateType],   // already a human label, e.g. "Participation"
    ['Issued',         data.issueDate ? new Date(data.issueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : undefined],
    ['Issued by',      data.issuer],
  ] : []

  return (
    <Dialog open onClose={onClose} title={`Certificate — ${participantName}`}>
      {state === 'loading' && (
        <p className="flex items-center gap-2 py-6 text-fs-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Checking this certificate…
        </p>
      )}

      {state === 'error' && (
        <p role="alert" className="py-6 text-fs-sm text-destructive">
          We could not verify this certificate right now. Please try again in a moment.
        </p>
      )}

      {state === 'ok' && data && (
        <div className="space-y-4">
          <p
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-fs-2xs font-bold uppercase tracking-wider',
              data.valid
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-50 text-red-700',
            )}
          >
            {data.valid ? 'Verified' : data.state === 'revoked' ? 'Revoked' : 'Not verified'}
          </p>

          <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-fs-sm">
            {rows.filter(([, v]) => !!v).map(([k, v]) => (
              <div key={k} className="col-span-3 grid grid-cols-3 gap-4">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="col-span-2 break-words font-medium text-foreground">{v}</dd>
              </div>
            ))}
          </dl>

          {data.state === 'revoked' && data.revokeReason && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-fs-2xs text-red-700">{data.revokeReason}</p>
          )}
        </div>
      )}
    </Dialog>
  )
}
