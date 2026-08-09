'use client'

// RD-RACEOPS-01 Sprint 3 · Commit driver.
//
// Drives the whole backend pipeline from the browser:
//   create session → store rows in chunks → verify against the start list → rank in pages
//   → build the public snapshot → (organizer reviews) → publish
//
// RD-RESULTS-CLOSURE-02 moved verification from last to third. The browser is not trusted
// to hold that order: /rank and /snapshot each re-check the persisted start-list result and
// refuse without it.
//
// The chunk/page loops use the drive-loop convention already established in this codebase
// (the registration importer repeatedly POSTs `.../process` until done). Every step is
// idempotent server-side, so a retried request cannot double-write.

import { useCallback, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import type { CreateSessionResponse } from '@/app/api/organizer/race-operations/sessions/route'
import type { AppendResultsResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/results/route'
import type { RankResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/rank/route'
import type { SnapshotBuildResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/snapshot/route'
import type { PublishResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/publish/route'
import type { VerifyResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/verify/route'
import type { CancelResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/cancel/route'
import type { ColumnMapping, NormalizedRaceResult } from '@/features/race-operations/types/results'
import type { ImportSessionView } from '@/features/race-operations/types/session'

const BASE = '/api/organizer/race-operations/sessions'

/** Hard stop on the rank drive-loop, so a server bug cannot spin the browser forever. */
const MAX_RANK_CALLS = 500
/** Same guard for the snapshot build loop. */
const MAX_SNAPSHOT_CALLS = 500

export type CommitPhase =
  | 'idle'
  | 'creating'
  | 'storing'
  | 'ranking'
  | 'snapshotting'   // building the public read model
  | 'verifying'     // RD-RESULTS-CLOSURE-01 · cross-checking against the start list
  | 'review'        // stored + ranked; awaiting the organizer's decision
  | 'publishing'
  | 'published'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export interface CommitProgress {
  storedRows:   number
  totalRows:    number
  rankedRows:   number
  snapshotRows: number
}

export interface SessionCommit {
  phase:    CommitPhase
  session:  ImportSessionView | null
  progress: CommitProgress
  error:    string | null
  /** RD-RESULTS-CLOSURE-01 · start-list result once verification has run. */
  verification: VerifyResponse | null

  /** create → store → rank. Stops at `review`; it never publishes. */
  start:   (input: StartCommitInput) => Promise<void>
  publish: () => Promise<void>
  cancel:  (reason?: string) => Promise<void>
  reset:   () => void
}

export interface StartCommitInput {
  eventId:  string
  passId:   string
  fileName: string
  fileHash: string
  provider: string
  mapping:  ColumnMapping
  /** Only rows the client believes are usable. The server re-validates regardless. */
  results:  readonly NormalizedRaceResult[]
  /** Total rows in the file, including rejected ones — recorded on the session. */
  totalRows: number
}

const ZERO: CommitProgress = { storedRows: 0, totalRows: 0, rankedRows: 0, snapshotRows: 0 }

export function useSessionCommit(): SessionCommit {
  const { getToken } = useAuth()

  const [phase,    setPhase]    = useState<CommitPhase>('idle')
  /** RD-RESULTS-CLOSURE-01 · the start-list result, so review can render it. */
  const [verification, setVerification] = useState<VerifyResponse | null>(null)
  const [session,  setSession]  = useState<ImportSessionView | null>(null)
  const [progress, setProgress] = useState<CommitProgress>(ZERO)
  const [error,    setError]    = useState<string | null>(null)

  const reset = useCallback(() => {
    setPhase('idle'); setSession(null); setProgress(ZERO); setError(null); setVerification(null)
  }, [])

  /** One authorized JSON call. Surfaces the server's own message — never a raw status. */
  const call = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')

    const res = await fetch(path, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    body === undefined ? undefined : JSON.stringify(body),
      cache:   'no-store',
    })

    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(detail?.error ?? 'That request could not be completed. Please try again.')
    }
    return await res.json() as T
  }, [getToken])

  const start = useCallback(async (input: StartCommitInput) => {
    setError(null)
    setProgress({ storedRows: 0, totalRows: input.totalRows, rankedRows: 0, snapshotRows: 0 })

    try {
      // ── 1. Immutable session ────────────────────────────────────────────────
      setPhase('creating')
      const created = await call<CreateSessionResponse>(BASE, {
        eventId:  input.eventId,
        passId:   input.passId,
        fileName: input.fileName,
        fileHash: input.fileHash,
        provider: input.provider,
        mapping:  input.mapping,
        totalRows: input.totalRows,
      })
      setSession(created.session)
      const sessionId = created.session.sessionId
      const chunkSize = created.chunkSize

      // ── 2. Draft rows, in server-declared chunks ────────────────────────────
      setPhase('storing')
      let stored = 0
      for (let i = 0; i < input.results.length; i += chunkSize) {
        const chunk = input.results.slice(i, i + chunkSize)
        const res = await call<AppendResultsResponse>(`${BASE}/${sessionId}/results`, { results: chunk })
        stored = res.storedRows
        setProgress(p => ({ ...p, storedRows: stored }))
      }

      if (stored === 0) {
        throw new Error('No rows were accepted by the server. Fix the errors in your file and try again.')
      }

      // ── 3. RD-RESULTS-CLOSURE-02 · check the file against the start list ───
      // Runs immediately after storing and BEFORE ranking, because everything downstream
      // is derived from this row set: ranks are computed across it, and the snapshot is a
      // copy of it. Verifying afterwards meant a rejected import had already produced a
      // full public read model, whose entries nothing ever deletes.
      //
      // One call, not a drive loop: "registered but missing from the file" is only
      // answerable over the complete set, so the server walks it in one pass.
      //
      // The server enforces this order too — /rank and /snapshot both refuse an unverified
      // or failing session — so a browser that called them out of order cannot get past it.
      setPhase('verifying')
      const verified = await call<VerifyResponse>(`${BASE}/${sessionId}/verify`)
      // The verify response carries the session with its persisted registrationCheck, so
      // this is the state review renders — no separate re-read, and no local guess about
      // what the publish guard will see.
      setVerification(verified)
      setSession(verified.session)

      // A blocking check stops the pipeline here, before ranking and before a single
      // snapshot entry exists. The organizer fixes the file and re-imports.
      if (verified.unknownRunner > 0 || verified.wrongRace > 0) {
        setPhase('review')
        return
      }

      // ── 4. Ranking, page by page ────────────────────────────────────────────
      setPhase('ranking')
      let done = false
      let calls = 0
      while (!done) {
        if (++calls > MAX_RANK_CALLS) {
          throw new Error('Ranking did not finish. Please try again, or contact support if it repeats.')
        }
        const res = await call<RankResponse>(`${BASE}/${sessionId}/rank`)
        done = res.done
        setSession(res.session)
        setProgress(p => ({ ...p, rankedRows: res.processed }))
      }

      // ── 5. Build the Official Snapshot (the public read model) ─────────────
      // Built BEFORE publish and left in `building` state, so a public page can never
      // observe a half-copied race. /publish then flips the session and the snapshot live
      // in one transaction.
      //
      // RD-RESULTS-CLOSURE-02 · the cursor below is now advisory only. The server persists
      // its own on the snapshot document and resumes from that, so a replayed chunk copies
      // the next page instead of re-copying one and inflating the published count.
      setPhase('snapshotting')
      let cursor: number | null = null
      let snapDone = false
      let snapCalls = 0
      while (!snapDone) {
        if (++snapCalls > MAX_SNAPSHOT_CALLS) {
          throw new Error('Preparing the public results page did not finish. Please try again.')
        }
        const body: { cursor?: number } = cursor === null ? {} : { cursor }
        const built: SnapshotBuildResponse =
          await call<SnapshotBuildResponse>(`${BASE}/${sessionId}/snapshot`, body)
        snapDone = built.done
        cursor   = built.nextCursor
        setProgress(p => ({ ...p, snapshotRows: p.snapshotRows + built.copied }))
      }

      setPhase('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import could not be completed.')
      setPhase('failed')
    }
  }, [call])

  const publish = useCallback(async () => {
    if (!session) return
    setError(null)
    setPhase('publishing')
    try {
      const res = await call<PublishResponse>(`${BASE}/${session.sessionId}/publish`)
      setSession(res.session)
      setPhase('published')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publishing failed.')
      // Back to review, not `failed`: the session is intact and still publishable once the
      // reported problem is resolved.
      setPhase('review')
    }
  }, [call, session])

  const cancel = useCallback(async (reason?: string) => {
    if (!session) return
    setError(null)
    setPhase('cancelling')
    try {
      const res = await call<CancelResponse>(`${BASE}/${session.sessionId}/cancel`, { reason })
      setSession(res.session)
      setPhase('cancelled')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancelling failed.')
      setPhase('review')
    }
  }, [call, session])

  return { phase, session, progress, error, verification, start, publish, cancel, reset }
}
