'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import {
  createEventDraft,
  loadEventDraft,
  saveEventDraft,
  type EventDraftDocument,
  type DraftPayload,
} from '@/lib/firebase/firestore/drafts'
import {
  createSnapshotScheduler, type SnapshotScheduler, type ScheduleHandle,
} from './snapshotScheduler'

export type { EventDraftDocument, DraftPayload }

// ─── RD-PRODUCT-01B — enterprise autosave & draft recovery ─────────────────────────
//
// This hook is the single owner of the event-draft's persistence lifecycle. It layers
// enterprise drafting guarantees on top of the existing Firestore draft doc WITHOUT
// changing the doc shape, the publish path, or any business logic:
//   • debounced autosave that coalesces changed fields and cancels on new input
//   • immediate saves (Continue / Save Draft) share the same status + retry machinery
//   • retry with exponential backoff; offline-safe (queues, flushes on reconnect)
//   • a real save-status state machine + lastSavedAt for the UI (never fakes success)
//   • a localStorage crash-recovery snapshot of unsynced edits
//   • cross-device / concurrent-edit conflict detection on load
//
// It never throws, never blocks typing, and never writes server-controlled fields.

const DRAFT_KEY    = 'rd_event_draft_id'          // active draftId for this browser
const SNAPSHOT_KEY = 'rd_event_draft_snapshot'    // crash-recovery snapshot

const DEBOUNCE_MS   = 1000
const MAX_RETRIES   = 6
const BACKOFF_BASE  = 800     // ms; capped exponential

// RD-EVENT-09 — how long a coalesced snapshot write may wait for an idle moment.
// Deliberately well below DEBOUNCE_MS: the snapshot must be on disk before the debounced
// network write is even attempted, so a crash mid-debounce still recovers every edit.
const SNAPSHOT_IDLE_TIMEOUT_MS = 400

/**
 * Schedules `cb` for an idle moment, with a hard `timeout` ceiling.
 *
 * `requestIdleCallback` is unavailable in Safari and in SSR, so both fall back to a plain
 * timer at the same ceiling. The fallback is the WORST case of the idle path, never slower,
 * which keeps the timing guarantee above true on every browser.
 */
function scheduleIdle(cb: () => void, timeout: number): ScheduleHandle {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(cb, { timeout }) as unknown as ScheduleHandle
  }
  return setTimeout(cb, timeout) as unknown as ScheduleHandle
}

function cancelIdle(handle: ScheduleHandle): void {
  if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle as unknown as number)
    return
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'retrying'

/** A local crash-recovery snapshot of the draft's unsynced edits. */
interface DraftSnapshot {
  draftId:          string
  draft:            EventDraftDocument   // full merged (optimistic) draft
  pendingKeys:      string[]             // fields not yet confirmed saved to the server
  clientUpdatedAt:  number               // ms — when the local edit happened
  baseUpdatedAtMs:  number | null        // server updatedAt we branched from
  device:           string
  updatedBy:        string | null
}

/** Presented to the UI when local unsaved edits and/or a server change are detected. */
export interface DraftConflict {
  kind:         'unsaved-local' | 'server-changed'
  snapshot:     DraftSnapshot
  serverDraft:  EventDraftDocument
}

function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  const mobile = /Mobi|Android|iPhone|iPad/.test(ua)
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Web'
  return `${os}${mobile ? ' · Mobile' : ''}`
}

function tsToMillis(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null
}

function readSnapshot(): DraftSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    return raw ? (JSON.parse(raw) as DraftSnapshot) : null
  } catch { return null }
}

function localDraft(id: string, payload: DraftPayload): EventDraftDocument {
  return {
    id,
    status:           'draft',
    currentStep:      0,
    completedValues:  Array(9).fill(null),
    eventType:          null,
    eventSubtype:       null,
    customEventSubtype: null,
    campaignType:       null,
    linkedCampaign:     null,
    visibility:         null,
    accessControl:    null,
    pricing:          null,
    registrationForm: null,
    eventDetails:     {},
    communicationBilling: null,
    publishedAt:          null,
    createdAt:        null,
    updatedAt:        null,
    ...payload,
  }
}

export function useDraft() {
  const { user } = useAuth()                        // RD-AUTH-01 Phase 1 (M-A): shared auth state
  const [draft,     setDraft]     = useState<EventDraftDocument | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [conflict, setConflict] = useState<DraftConflict | null>(null)

  const uidRef      = useRef<string | null>(null)
  const draftIdRef  = useRef<string | null>(null)
  const creatingRef = useRef<Promise<string | null> | null>(null)

  // Autosave machinery
  const pendingRef  = useRef<DraftPayload>({})   // coalesced changed fields awaiting write
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef   = useRef(false)
  const retryRef    = useRef(0)
  const draftRef    = useRef<EventDraftDocument | null>(null)
  const baseMsRef   = useRef<number | null>(null)   // server updatedAt we branched from
  const flushRef    = useRef<(() => Promise<void>) | null>(null)   // latest flush, for self-scheduled retries

  useEffect(() => { draftRef.current = draft }, [draft])

  // ── Crash-recovery snapshot ──────────────────────────────────────────────────
  const writeSnapshot = useCallback((pendingKeys: string[]) => {
    const id = draftIdRef.current
    const d  = draftRef.current
    if (!id || !d) return
    const snap: DraftSnapshot = {
      draftId: id, draft: d, pendingKeys,
      clientUpdatedAt: Date.now(), baseUpdatedAtMs: baseMsRef.current,
      device: deviceLabel(), updatedBy: uidRef.current,
    }
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)) } catch { /* quota — ignore */ }
  }, [])


  // ── RD-EVENT-09 · snapshot writes are coalesced off the input path ───────────
  //
  // `queue()` used to call `writeSnapshot` synchronously on every autosave emit — one full
  // `JSON.stringify` of the WHOLE draft plus a synchronous `localStorage.setItem` per
  // keystroke. The scheduler below coalesces those into one idle write, and every point
  // where the page may stop running forces it out first (see the lifecycle effect).
  //
  // Content is UNCHANGED: the same `writeSnapshot` builds the same `DraftSnapshot` under
  // the same key. Only the moment of writing moves.
  // Created exactly once, via a lazy state initializer — the scheduler is an instance, not
  // a rendered value, and it must not be rebuilt on re-render or its pending write is lost.
  // The scheduler holds no refs — the writer is handed to `markDirty` at event time, and
  // reads `pendingRef` when it actually runs, so a coalesced burst always persists the
  // latest set of unsynced keys rather than the first keystroke's.
  const [snapshot] = useState<SnapshotScheduler>(() => createSnapshotScheduler({
    schedule: cb => scheduleIdle(cb, SNAPSHOT_IDLE_TIMEOUT_MS),
    cancel:   h  => cancelIdle(h),
  }))

  const clearPendingSnapshot = useCallback(() => {
    // Drop any pending write first: it was computed from state this call is about to
    // supersede, and letting it land afterwards would re-add pending keys we just cleared.
    snapshot.cancel()
    try {
      const snap = readSnapshot()
      if (snap && snap.draftId === draftIdRef.current) {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snap, pendingKeys: [], draft: draftRef.current ?? snap.draft }))
      }
    } catch { /* ignore */ }
  }, [snapshot])

  const recomputeUnsaved = useCallback(() => {
    setHasUnsavedChanges(Object.keys(pendingRef.current).length > 0 || savingRef.current)
  }, [])

  /**
   * RD-EVENT-12 — bring render state up to date with persistence.
   *
   * The ONE place `draft` state advances outside load/create/conflict. Passing the ref's
   * current object means React bails out via `Object.is` when nothing has been edited, so
   * calling this on every navigation costs a render only when there is something to show.
   */
  const syncRenderState = useCallback(() => {
    setDraft(draftRef.current)
  }, [])

  // ── The write path (shared by autosave + immediate saves) ────────────────────
  const flush = useCallback(async (): Promise<void> => {
    const uid = uidRef.current, draftId = draftIdRef.current
    const payload = pendingRef.current
    const keys = Object.keys(payload)
    if (!uid || !draftId || keys.length === 0 || savingRef.current) return

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSaveState('offline'); recomputeUnsaved(); return   // queued; flushed on reconnect
    }

    savingRef.current = true
    setSaveState(retryRef.current > 0 ? 'retrying' : 'saving')
    recomputeUnsaved()

    const inFlight = { ...payload }
    pendingRef.current = {}   // new edits during the write accumulate separately

    try {
      await saveEventDraft(uid, draftId, inFlight)
      retryRef.current = 0
      savingRef.current = false
      // M2: baseMsRef is the SERVER updatedAt we branched from — it is later compared
      // against the server's updatedAt on the next load (line ~229). The server's
      // post-save timestamp is unknown here (updatedAt resolves via serverTimestamp on
      // the server), so mark the baseline UNKNOWN rather than stamping client Date.now().
      // The null guard at load then avoids a client-vs-server clock comparison. Client
      // time is never treated as authoritative.
      baseMsRef.current = null
      setLastSavedAt(Date.now())
      // Audited sync point: saveSuccess. The write landed, so render state should show what
      // was persisted. Because the debounce timer restarts on every keystroke, this cannot
      // fire mid-burst — only once typing pauses.
      syncRenderState()
      clearPendingSnapshot()
      if (Object.keys(pendingRef.current).length > 0) {
        setSaveState('saving'); void flushRef.current?.()   // coalesced edits arrived mid-write
      } else {
        setSaveState('saved'); recomputeUnsaved()
      }
    } catch (err) {
      // Re-queue the in-flight fields (newer pending edits win on key collision).
      pendingRef.current = { ...inFlight, ...pendingRef.current }
      savingRef.current = false
      // Audited sync point: saveFailure. Rare, but the error/retry UI must not present
      // pre-edit data as the thing that failed to save.
      syncRenderState()
      // The save FAILED — the snapshot is now the only record of these edits, so it is
      // written immediately and synchronously, never scheduled. `cancel()` first so a
      // pending idle write cannot fire again for the same dirty period.
      snapshot.cancel()
      writeSnapshot(Object.keys(pendingRef.current))
      if (retryRef.current >= MAX_RETRIES) {
        setSaveState('error'); recomputeUnsaved()
        console.error('[useDraft] save failed after retries:', err)
        return
      }
      retryRef.current += 1
      setSaveState('retrying'); recomputeUnsaved()
      const delay = Math.min(BACKOFF_BASE * 2 ** (retryRef.current - 1), 15000)
      setTimeout(() => { void flushRef.current?.() }, delay)
    }
  }, [clearPendingSnapshot, recomputeUnsaved, writeSnapshot, snapshot, syncRenderState])

  // ── RD-EVENT-09 · the guarantee that deferral is safe ────────────────────────
  // A coalesced write is only sound if it cannot be lost when the page stops running.
  // `pagehide` and `visibilitychange`→hidden are the reliable points for that — mobile
  // browsers may never fire `beforeunload`. Both are idempotent: `flushNow()` is a no-op
  // when nothing is dirty, so a hide/show cycle writes at most once.
  useEffect(() => {
    const force = () => snapshot.flushNow()
    const onVisibility = () => { if (document.visibilityState === 'hidden') force() }
    window.addEventListener('pagehide', force)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', force)
      document.removeEventListener('visibilitychange', onVisibility)
      force()   // unmounting the builder must not strand an unwritten snapshot
    }
  }, [snapshot])

  // Keep the self-scheduled retry/coalesce path pointed at the latest flush.
  useEffect(() => { flushRef.current = flush }, [flush])

  const queue = useCallback((payload: DraftPayload, immediate: boolean) => {
    if (!draftIdRef.current) return
    pendingRef.current = { ...pendingRef.current, ...payload }
    // RD-EVENT-12 — PERSISTENCE advances here; RENDER state deliberately does not.
    //
    // This line used to be accompanied by `setDraft(prev => ({ ...prev, ...payload }))`,
    // which allocated a new draft object and therefore re-rendered the 4,000-line wizard on
    // every keystroke — for data no mounted consumer reads. The active step owns its own
    // editable state and seeds `initialData` once through a lazy `useState` initializer, so
    // feeding the draft back mid-edit only produced work.
    //
    // `draftRef` is the authority for Firestore and for the crash snapshot, so it must stay
    // current on every edit. Render state catches up at the audited synchronisation points
    // — see `syncRenderState` and `lib/hooks/draftRenderSync.ts`.
    draftRef.current = draftRef.current ? { ...draftRef.current, ...payload } : draftRef.current
    snapshot.markDirty(() => writeSnapshot(Object.keys(pendingRef.current)))
    setHasUnsavedChanges(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (immediate) { void flush() }
    else { setSaveState('saving'); timerRef.current = setTimeout(() => { void flush() }, DEBOUNCE_MS) }
  }, [flush, snapshot, writeSnapshot])

  // ── Auth + rehydrate + conflict detection ────────────────────────────────────
  useEffect(() => {
    if (user === undefined) return                      // auth still resolving
    let cancelled = false
    const run = async () => {
      if (!user) { setIsLoading(false); return }
      uidRef.current = user.uid
      const storedId = localStorage.getItem(DRAFT_KEY)
      try {
        if (storedId) {
          const existing = await loadEventDraft(user.uid, storedId)
          if (cancelled) return
          if (existing) {
            draftIdRef.current = storedId
            const serverMs = tsToMillis(existing.updatedAt)
            baseMsRef.current = serverMs
            const snap = readSnapshot()
            if (snap && snap.draftId === storedId && snap.pendingKeys.length > 0) {
              // Unsynced local edits exist. If the server also moved since we branched,
              // it's a cross-device conflict; otherwise it's a plain crash-recovery.
              const serverMoved = snap.baseUpdatedAtMs != null && serverMs != null && serverMs > snap.baseUpdatedAtMs
              setConflict({ kind: serverMoved ? 'server-changed' : 'unsaved-local', snapshot: snap, serverDraft: existing })
              setDraft(existing)   // show server version until the user chooses
            } else {
              setDraft(existing)
            }
            setLastSavedAt(serverMs)
            setIsLoading(false)
            return
          }
          localStorage.removeItem(DRAFT_KEY)
        }
      } catch (err) {
        console.error('[useDraft] init failed:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [user])

  // ── Offline / online + flush-before-unload ───────────────────────────────────
  useEffect(() => {
    const onOnline = () => { if (Object.keys(pendingRef.current).length > 0) { retryRef.current = 0; void flush() } }
    const onOffline = () => setSaveState('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [flush])

  // ── Public API ───────────────────────────────────────────────────────────────
  const createDraft = useCallback(async (payload: DraftPayload): Promise<string | null> => {
    const uid = uidRef.current
    if (!uid) return null
    if (draftIdRef.current)  return draftIdRef.current
    if (creatingRef.current) return creatingRef.current
    const promise = (async () => {
      const newId = await createEventDraft(uid, payload)
      localStorage.setItem(DRAFT_KEY, newId)
      draftIdRef.current = newId
      // M2: unknown server baseline on a fresh draft — never client time (see flush).
      baseMsRef.current = null
      const d = localDraft(newId, payload)
      setDraft(d); draftRef.current = d
      setLastSavedAt(Date.now()); setSaveState('saved')
      return newId
    })()
    creatingRef.current = promise
    try { return await promise }
    catch (err) { console.error('[useDraft] createDraft failed:', err); creatingRef.current = null; return null }
  }, [])

  /** Immediate persist (Continue / Save Draft). Shares status + retry with autosave. */
  const updateDraft = useCallback(async (payload: DraftPayload) => {
    if (!draftIdRef.current) return
    queue(payload, true)
  }, [queue])

  /** Debounced persist (within-step edits). Coalesces + cancels on new input. */
  const autosaveDraft = useCallback((payload: DraftPayload) => {
    if (!draftIdRef.current) return
    queue(payload, false)
  }, [queue])

  /** Force any pending write to flush now (e.g. before navigating away / publishing). */
  const flushNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    retryRef.current = 0
    void flush()
  }, [flush])

  /**
   * M1 — post-publish baseline alignment. Publish advances the server's `updatedAt`
   * OUTSIDE the autosave path (it goes through the publish API, not `flush`). Without
   * this, a pre-publish crash-recovery snapshot keeps its stale `baseUpdatedAtMs`, and
   * because publish moved the server clock forward, the next load reads it as a
   * `server-changed` conflict that never happened. Drop the local baseline (unknown →
   * the next load re-reads the server `updatedAt` as the single authoritative baseline)
   * and clear the snapshot's pending keys so no stale baseline is compared on reopen.
   */
  const markPublished = useCallback(() => {
    baseMsRef.current = null
    try {
      const snap = readSnapshot()
      if (snap && snap.draftId === draftIdRef.current) {
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snap, pendingKeys: [] }))
      }
    } catch { /* ignore */ }
  }, [])

  /** Resolve a detected conflict: keep the local unsynced edits, or discard them. */
  const resolveConflict = useCallback((keepLocal: boolean) => {
    const c = conflict
    setConflict(null)
    if (!c) return
    if (keepLocal) {
      setDraft(c.snapshot.draft); draftRef.current = c.snapshot.draft
      // Re-queue the unsynced fields so they persist to the server.
      const revived: DraftPayload = {}
      for (const k of c.snapshot.pendingKeys) {
        ;(revived as Record<string, unknown>)[k] = (c.snapshot.draft as unknown as Record<string, unknown>)[k]
      }
      pendingRef.current = { ...pendingRef.current, ...revived }
      setHasUnsavedChanges(true)
      flushNow()
    } else {
      setDraft(c.serverDraft); draftRef.current = c.serverDraft
      try { const s = readSnapshot(); if (s) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...s, pendingKeys: [] })) } catch { /* ignore */ }
    }
  }, [conflict, flushNow])

  return {
    draft, isLoading, createDraft, updateDraft, autosaveDraft, flushNow, markPublished, syncRenderState,
    saveState, lastSavedAt, hasUnsavedChanges, conflict, resolveConflict,
  }
}
