'use client'

// RD-PRINT-BILL-P6 · Starting (or re-running) badge generation through the Phase 5 contracts.
//
//   NEW job   POST /api/organizer/print-jobs/quote  → mode
//               free / complimentary → POST /api/organizer/print-jobs { templateId, filters, requestId }
//               paid                 → show the server quote → owner confirms →
//                                      POST /api/organizer/print-jobs { templateId, filters, requestId, quote }
//   PAID job  POST /api/organizer/print-jobs/[jobId]/retry { mode, registrationIds?, quote? }
//             (free jobs keep their existing /process and /retry calls — this controller is not used)
//
// ONE requestId per user intent: created when the intent starts, reused by every resubmission of
// it — quote refreshes, network retries and REQUEST_IN_PROGRESS polling. Only start() (a new intent)
// makes a new one. REQUEST_ID_REUSED is a conflict, never answered by silently re-sending under a new id.
//
// The browser decides NOTHING about money: the quote, chargeable count, balance and price are shown
// exactly as the server returned them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import type { PrintBadgeQuote, PrintGenerationFilters } from '@/lib/printAssets/generationJob'
import { mapGenerationResponse, type BadgeGenerationOutcome, type QuoteReason } from './badgeErrors'

export type BadgeIntent =
  | { kind: 'create'; templateId: string; filters: PrintGenerationFilters }
  | { kind: 'reopen'; jobId: string; mode: 'retry' | 'regenerate'; registrationIds?: string[] }

export type BadgeGenerationState =
  | { phase: 'idle' }
  | { phase: 'quoting' }
  /** A paid run waits for the organizer to confirm the server's quote. */
  | { phase: 'confirm'; quote: PrintBadgeQuote; reason: QuoteReason | null }
  | { phase: 'submitting' }
  /** REQUEST_IN_PROGRESS — retrying the SAME request with backoff until `deadline`. */
  | { phase: 'waiting'; attempt: number; nextAt: number; deadline: number }
  /** The waiting deadline passed: nothing more is sent until the organizer asks (resume). */
  | { phase: 'timeout' }
  | { phase: 'done'; jobId: string | null; existing: boolean; billingMode: 'free' | 'complimentary' | 'paid' }
  | { phase: 'blocked'; outcome: Exclude<BadgeGenerationOutcome, { kind: 'success' } | { kind: 'needs_quote' } | { kind: 'in_progress' }> }

export const IN_PROGRESS_WINDOW_MS = 5 * 60_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS  = 30_000
/** Delay before the n-th (0-based) retry of an in-progress request: 2s, 4s, 8s, 16s, 30s, 30s… */
export const backoffDelay = (n: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, n))

export interface ControllerDeps {
  post:   (url: string, body: unknown) => Promise<{ status: number; body: unknown }>
  now:    () => number
  setTimer:   (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  newRequestId: () => string
  onChange: (s: BadgeGenerationState) => void
}

/**
 * The generation state machine, free of React (unit-tested with fake timers and a fake server).
 * Every async step checks `epoch`: a response or timer belonging to an intent that was reset,
 * replaced or disposed is dropped, so a stale request can never update the screen.
 */
export function createBadgeGenerationController(d: ControllerDeps) {
  let state: BadgeGenerationState = { phase: 'idle' }
  let epoch = 0
  let intent: BadgeIntent | null = null
  let requestId: string | null = null
  let quote: PrintBadgeQuote | null = null
  let billingMode: 'free' | 'complimentary' | 'paid' = 'free'
  let timer: unknown = null
  let waitStartedAt: number | null = null
  let attempt = 0

  const set = (s: BadgeGenerationState) => { state = s; d.onChange(s) }
  const stopTimer = () => { if (timer !== null) { d.clearTimer(timer); timer = null } }

  function body(): unknown {
    if (!intent) return null
    if (intent.kind === 'create') {
      return { templateId: intent.templateId, filters: intent.filters, requestId, ...(quote ? { quote } : {}) }
    }
    return { mode: intent.mode, ...(intent.registrationIds?.length ? { registrationIds: intent.registrationIds } : {}), ...(quote ? { quote } : {}) }
  }
  const submitUrl = () => intent!.kind === 'create'
    ? '/api/organizer/print-jobs'
    : `/api/organizer/print-jobs/${encodeURIComponent(intent!.jobId)}/retry`

  async function submit(myEpoch: number): Promise<void> {
    if (myEpoch !== epoch || !intent) return
    stopTimer()
    if (state.phase !== 'waiting') set({ phase: 'submitting' })
    let res: { status: number; body: unknown }
    try { res = await d.post(submitUrl(), body()) } catch { res = { status: 0, body: null } }
    if (myEpoch !== epoch) return
    handle(mapGenerationResponse(res.status, res.body), myEpoch)
  }

  function handle(o: BadgeGenerationOutcome, myEpoch: number): void {
    switch (o.kind) {
      case 'success':
        waitStartedAt = null
        return set({ phase: 'done', jobId: o.jobId, existing: o.existing, billingMode })
      case 'needs_quote':
        waitStartedAt = null
        if (!o.quote) return set({ phase: 'blocked', outcome: { kind: 'error', message: o.message, retryable: true } })
        quote = null   // a fresh quote must be CONFIRMED before it is sent
        billingMode = 'paid'
        return set({ phase: 'confirm', quote: o.quote, reason: o.reason })
      case 'in_progress': {
        const t = d.now()
        if (waitStartedAt === null) { waitStartedAt = t; attempt = 0 }
        const deadline = waitStartedAt + IN_PROGRESS_WINDOW_MS
        if (t >= deadline) { waitStartedAt = null; return set({ phase: 'timeout' }) }
        const delay = Math.min(backoffDelay(attempt), deadline - t)
        attempt++
        set({ phase: 'waiting', attempt, nextAt: t + delay, deadline })
        stopTimer()
        timer = d.setTimer(() => { timer = null; void submit(myEpoch) }, delay)
        return
      }
      default:
        waitStartedAt = null
        return set({ phase: 'blocked', outcome: o })
    }
  }

  return {
    get state() { return state },
    /** The current intent's requestId (null for a reopen, which the retry route does not take). */
    get requestId() { return requestId },

    /** A NEW user intent — a new requestId. Anything still running for the previous one is dropped. */
    async start(next: BadgeIntent): Promise<void> {
      const myEpoch = ++epoch
      stopTimer()
      intent = next; quote = null; waitStartedAt = null; attempt = 0; billingMode = 'free'
      requestId = next.kind === 'create' ? d.newRequestId() : null
      if (next.kind === 'reopen') { billingMode = 'paid'; return submit(myEpoch) }
      set({ phase: 'quoting' })
      let res: { status: number; body: unknown }
      try { res = await d.post('/api/organizer/print-jobs/quote', { templateId: next.templateId, filters: next.filters }) } catch { res = { status: 0, body: null } }
      if (myEpoch !== epoch) return
      const b = (res.body ?? {}) as { success?: boolean; mode?: string; quote?: PrintBadgeQuote }
      if (res.status === 200 && b.success === true && (b.mode === 'free' || b.mode === 'complimentary')) {
        billingMode = b.mode
        return submit(myEpoch)
      }
      if (res.status === 200 && b.success === true && b.mode === 'paid' && b.quote) {
        billingMode = 'paid'
        return set({ phase: 'confirm', quote: b.quote, reason: null })
      }
      return handle(mapGenerationResponse(res.status, res.body), myEpoch)
    },

    /** The organizer accepted the quote on screen: send it, with the SAME requestId. */
    confirm(): Promise<void> {
      if (state.phase !== 'confirm') return Promise.resolve()
      quote = state.quote
      return submit(epoch)
    },

    /** Re-send the SAME request (after a network error or a timed-out wait). Never a new requestId. */
    resume(): Promise<void> {
      if (!intent) return Promise.resolve()
      waitStartedAt = null
      return submit(epoch)
    },

    /** Drop the intent (dialog closed, event changed, unmount). Late responses are ignored. */
    reset(): void {
      epoch++; stopTimer()
      intent = null; requestId = null; quote = null; waitStartedAt = null
      set({ phase: 'idle' })
    },

    dispose(): void { epoch++; stopTimer() },
  }
}

export type BadgeGenerationController = ReturnType<typeof createBadgeGenerationController>

async function authedPost(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const token = await auth.currentUser?.getIdToken()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * React binding. `scopeKey` is the event the surface is showing: when it changes, any intent in
 * flight is dropped, so a quote for one event can never be submitted under another.
 */
export function useBadgeGeneration(
  scopeKey: string | null,
  /** Called once when a job is created (or found already created) — the surface's own follow-up. */
  opts: { onDone?: (s: Extract<BadgeGenerationState, { phase: 'done' }>) => void } = {},
) {
  const onDoneRef = useRef(opts.onDone)
  useEffect(() => { onDoneRef.current = opts.onDone })
  const [state, setState] = useState<BadgeGenerationState>({ phase: 'idle' })
  // One controller for the component's life (lazy initial state — created once, never re-created).
  const [c] = useState<BadgeGenerationController>(() => createBadgeGenerationController({
    post: authedPost,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: h => window.clearTimeout(h as number),
    newRequestId: () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `rq-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    onChange: s => setState(s),
  }))
  useEffect(() => () => c.dispose(), [c])
  // The surface's follow-up, once per completed job (the state object is new for every outcome).
  const firedFor = useRef<BadgeGenerationState | null>(null)
  useEffect(() => {
    if (state.phase !== 'done' || firedFor.current === state) return
    firedFor.current = state
    onDoneRef.current?.(state)
  }, [state])
  useEffect(() => { c.reset() }, [c, scopeKey])

  const start   = useCallback((i: BadgeIntent) => c.start(i), [c])
  const confirm = useCallback(() => c.confirm(), [c])
  const resume  = useCallback(() => c.resume(), [c])
  const reset   = useCallback(() => c.reset(), [c])
  return useMemo(() => ({ state, start, confirm, resume, reset }), [state, start, confirm, resume, reset])
}
