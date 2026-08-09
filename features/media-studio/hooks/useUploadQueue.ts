'use client'

// RD-MEDIA-01 · The upload queue executor.
//
// Drives, per photo: compress in the browser → ask the server for signed PUT URLs → PUT each
// rendition directly to object storage → register the metadata.
//
// The RULES live in utils/queueMachine.ts (pure, unit-tested). This hook only performs I/O
// and applies those rules, so the hard part is verifiable without a browser.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import {
  MAX_CONCURRENT_UPLOADS, countByState, nextState, queueProgressPercent,
  type ProgressStage, type QueueAction, type UploadItemState,
} from '@/features/media-studio/utils/queueMachine'
import { UploadTimings, reportTimings } from '@/features/media-studio/utils/uploadTimings'
import { hashBytes, processImage, putToSignedUrl, type PreparedOverlay } from '@/features/media-studio/utils/browserImage'
import { prepareOverlay } from '@/features/photo-branding/utils/prepareOverlay'
import type { BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'
import type { CompressionProfile } from '@/features/media-studio/utils/compressionProfiles'
import type { MediaRendition } from '@/features/media-studio/types'
import {
  UploadRequestError, classifyUploadError, formatUploadFailure, summariseFailures,
  type UploadFailure,
} from '@/features/media-studio/utils/uploadErrors'
import { assignSlots, newUploadSessionId } from '@/features/media-studio/utils/uploadSession'
import { createSerialRunner } from '@/features/media-studio/utils/serialRunner'
import type { DuplicateMatch, DuplicateScan } from '@/features/media-studio/utils/duplicates'
import type { PrepareUploadResponse } from '@/app/api/organizer/media-studio/uploads/prepare/route'
import type { CompleteUploadResponse } from '@/app/api/organizer/media-studio/uploads/complete/route'

const API = '/api/organizer/media-studio'
/** MC-10.6 · the credits module's own base — a different route tree to the media one. */
const API_CREDITS = '/api/organizer/media-credits'

/**
 * MC-10.5 · Turns a non-OK response into an error that still knows what the server said.
 *
 * Reads the body ONCE — a Response body can only be consumed once, and the previous code
 * parsed it solely to pull `error` out and discard the rest.
 */
async function requestError(res: Response, fallback: string): Promise<UploadRequestError> {
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  const message = typeof body?.error === 'string' ? body.error : fallback
  const code    = typeof body?.code  === 'string' ? body.code  : null
  return new UploadRequestError(message, res.status, code, body)
}

export interface QueueItem {
  id:       string
  file:     File
  state:    UploadItemState
  error:    string | null
  /**
   * RD-MEDIA-03: the classified failure, so the UI can say WHY and WHAT TO DO rather than
   * repeating "Upload failed." for six unrelated causes.
   */
  failure:  UploadFailure | null
  /** Bytes actually stored once complete. */
  storedBytes: number
  checksum: string | null
  /**
   * RD-MEDIA-PERF-03 · the pipeline stage last COMPLETED, or null before anything has.
   *
   * Drives both the per-photo checklist and the weighted progress bar. Without it an item
   * showed "processing" from the moment work began until it finished — one label covering
   * the decode, three encodes, the prepare call, three PUTs and the complete call.
   */
  stage: ProgressStage | null
  /**
   * MC-10.2 · The credit slot this photo uploads into.
   *
   * Assigned once, at `start`, and never reassigned — a retry reuses it, which is what makes
   * the retry land on the same derived assetId instead of consuming a second slot. Null
   * until the item has been through `start`, and harmless when credits are switched off:
   * `/uploads/prepare` ignores all three fields in that case.
   */
  sessionId:    string | null
  slotIndex:    number | null
  sessionSlots: number | null
  /**
   * MS-FINAL-01 · The sha256 of the ORIGINAL bytes, computed in the pre-flight scan.
   *
   * Kept so `processImage` does not hash the same file a second time: the scan already read
   * and digested every byte, and re-doing it over a 3,000-photo folder is minutes of CPU for
   * an answer we already have.
   */
  checksumPrecomputed: string | null
  /**
   * The already-stored photo this one matches, or null. Set only on items in the
   * `duplicate` state — the existing state, driven for the first time here.
   */
  duplicateOf: DuplicateMatch['existing'] | null
}

/**
 * RD-PHOTO-03 · What the run needs in order to brand.
 *
 * Deliberately NOT a decoded bitmap: the queue fetches and decodes it once, at the start of
 * `drive`, and closes it at the end. A caller handing over a bitmap would have to own that
 * lifetime across pause, resume, retry and cancel.
 */
export interface BrandingSource {
  eventId: string
  style:   BrandingStyle
}

export interface UploadTarget {
  /**
   * MS-FINAL-01 · Required by the duplicate scan, which searches within ONE event — the
   * same photo in two different events is two legitimate uploads.
   */
  eventId:   string
  galleryId: string
  albumId:   string | null
  profile:   CompressionProfile
  plan:      { keepOriginal: boolean; generateMedium: boolean; generateThumbnail: boolean }
  /** Null when this event has no branding, or branding is switched off. */
  branding:  BrandingSource | null
}

export interface UploadQueue {
  items:    QueueItem[]
  running:  boolean
  paused:   boolean
  progress: number
  counts:   ReturnType<typeof countByState>
  /** Every distinct failure cause in the queue, most common first. */
  failures: ReturnType<typeof summariseFailures>
  /**
   * MC-10.6 · True while cancelled sessions are being closed server-side, so the credits
   * they held come back now rather than in six hours.
   */
  releasing: boolean
  /** MS-FINAL-01 · True while the pre-flight duplicate scan is hashing and asking. */
  scanning:  boolean
  add:      (files: File[]) => void
  /**
   * Applies the organizer's decision to EVERY item currently in the `duplicate` state.
   *
   * 'upload' re-queues them (they then get slots like any other photo); 'skip' cancels them,
   * which is terminal and costs no credits. Nothing else in the queue is touched.
   */
  resolveDuplicates: (decision: 'upload' | 'skip') => void
  start:    (target: UploadTarget) => void
  pause:    () => void
  resume:   () => void
  retryFailed: () => void
  cancelAll:   () => void
  clear:    () => void
}

let seq = 0
const nextId = () => `q${++seq}`

export function useUploadQueue(): UploadQueue {
  const { getToken } = useAuth()
  const [items,   setItems]   = useState<QueueItem[]>([])
  const [running, setRunning] = useState(false)
  const [paused,  setPaused]  = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [scanning,  setScanning]  = useState(false)

  // Refs mirror state for the async driver: reading `items` from a closure would see a
  // stale snapshot mid-run.
  const itemsRef  = useRef<QueueItem[]>([])
  const pausedRef = useRef(false)
  const abortRef  = useRef(false)

  // ── MC-10.4 · restarting the driver ────────────────────────────────────────
  // The upload target of the current run. Resume needs it, and asking the caller to hand it
  // back would change this hook's public API for every consumer — the target has not changed,
  // so remembering it is both smaller and more honest than re-passing it.
  const targetRef = useRef<UploadTarget | null>(null)
  // Serialises driver runs. See utils/serialRunner.ts: a Resume pressed while the previous
  // driver is still winding down must wait for it, never race it.
  const runSerially = useRef(createSerialRunner()).current

  // Synced in an effect, never during render: writing a ref while rendering is a React
  // violation and can leave the driver reading a value the UI never committed.
  useEffect(() => { itemsRef.current = items }, [items])

  const setItemState = useCallback((id: string, action: QueueAction, patch?: Partial<QueueItem>) => {
    setItems(prev => prev.map(it => {
      if (it.id !== id) return it
      const next = nextState(it.state, action)
      // An illegal transition leaves the item untouched rather than forcing a state — the
      // machine is the authority.
      return next ? { ...it, state: next, ...patch } : it
    }))
  }, [])

  /**
   * Records the stage a photo has reached.
   *
   * Separate from `setItemState` on purpose: a stage change is not a state-machine
   * transition, and routing it through `nextState` would either be refused or would have to
   * loosen the machine. The machine stays closed; the stage is presentation.
   */
  const setItemStage = useCallback((id: string, stage: ProgressStage) => {
    setItems(prev => prev.map(it => (it.id === id ? { ...it, stage } : it)))
  }, [])

  const add = useCallback((files: File[]) => {
    setItems(prev => [
      ...prev,
      ...files.map(file => ({
        id: nextId(), file, state: 'queued' as UploadItemState,
        error: null, failure: null, storedBytes: 0, checksum: null, stage: null,
        sessionId: null, slotIndex: null, sessionSlots: null,
        checksumPrecomputed: null, duplicateOf: null,
      })),
    ])
  }, [])

  /** One photo, end to end. */
  const runItem = useCallback(async (
    item: QueueItem, target: UploadTarget, token: string, overlay: PreparedOverlay | null,
    timings: UploadTimings,
  ) => {
    setItemState(item.id, 'start')

    // 1. Read once, checksum those bytes, decode them, then compress + brand. Every stage is
    //    measured and announced, so the UI can name what is happening (RD-MEDIA-PERF-03).
    setItemState(item.id, 'beginProcessing')

    let mark = performance.now()
    const processed = await processImage(
      item.file, target.profile, target.plan, overlay,
      stage => {
        // Entering `stage` means the previous one just finished.
        const end = performance.now()
        if (stage !== 'read') {
          const prev: ProgressStage =
            stage === 'checksum' ? 'read' : stage === 'decode' ? 'checksum' : 'decode'
          timings.record({ stage: prev, start: mark, end })
          setItemStage(item.id, prev)
        }
        mark = end
      },
      // MS-FINAL-01 · the pre-flight scan already digested these bytes; `processImage`
      // skips its own hash rather than repeating it.
      item.checksumPrecomputed,
    )
    timings.record({ stage: 'encode', start: mark, end: performance.now() })
    setItemStage(item.id, 'encode')

    // 2. Ask the server for one signed PUT URL per rendition. The server validates type and
    //    size and chooses the key — the browser never picks a path.
    const prepareRes = await timings.measure('prepare', () => fetch(`${API}/uploads/prepare`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        galleryId: target.galleryId,
        albumId:   target.albumId,
        renditions: processed.renditions.map(r => ({
          rendition: r.rendition, mimeType: r.mimeType, size: r.blob.size,
        })),
        // MC-10.2 · The credit slot. Required by the server whenever `creditsEnabled` is on,
        // and ignored by it when off — so these are sent unconditionally rather than gated on
        // a flag the client would have to fetch and could read staler than the server's own.
        //
        // The values come off the ITEM, assigned once at `start`. Computing a slot here, at
        // dispatch time, would hand a retry a different index and so a different assetId —
        // a second slot consumed for one photo.
        sessionId:    item.sessionId,
        slotIndex:    item.slotIndex,
        sessionSlots: item.sessionSlots,
      }),
    }))
    if (!prepareRes.ok) {
      // MC-10.5 · the WHOLE refusal, not just its sentence. A 402 carries the credits
      // required and available, and flattening it to a string threw those away — which is
      // how running out of credits came to read as an unclassified failure.
      throw await requestError(prepareRes, 'The server refused this upload.')
    }
    const prepared = await prepareRes.json() as PrepareUploadResponse
    setItemStage(item.id, 'prepare')

    // 3. PUT each rendition straight to object storage.
    const byRendition = new Map<MediaRendition, typeof processed.renditions[number]>(
      processed.renditions.map(r => [r.rendition, r]),
    )
    // RD-MEDIA-PERF-03: CONCURRENT. These are independent objects with independent signed
    // URLs — nothing ordered them except a `for…await`. Serially this was three full
    // round trips; the thumbnail and medium now ride alongside the original, so a photo's
    // upload costs roughly what its LARGEST rendition costs.
    await timings.measure('put', () => Promise.all(
      prepared.renditions.map(r => {
        const blob = byRendition.get(r.rendition)
        return blob ? putToSignedUrl(r.uploadUrl, blob.blob, r.mimeType) : Promise.resolve()
      }),
    ))
    setItemStage(item.id, 'put')

    // 4. Register the metadata. The server HEADs every key, so a claim it cannot verify
    //    is rejected.
    const completeRes = await timings.measure('complete', () => fetch(`${API}/uploads/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId:   prepared.assetId,
        galleryId: target.galleryId,
        albumId:   target.albumId,
        checksum:  processed.checksum,
        profileId: target.profile.id,
        originalFilename: item.file.name,
        bytesOriginalSource: item.file.size,
        renditions: prepared.renditions.map(r => {
          const b = byRendition.get(r.rendition)
          return { rendition: r.rendition, path: r.path, width: b?.width ?? null, height: b?.height ?? null }
        }),
      }),
    }))
    if (!completeRes.ok) {
      throw await requestError(completeRes, 'The upload could not be recorded.')
    }
    const done = await completeRes.json() as CompleteUploadResponse

    timings.photoCompleted()
    setItemState(item.id, 'succeed', {
      storedBytes: done.asset.bytesStored, checksum: processed.checksum,
      error: null, failure: null, stage: 'complete',
    })
  }, [setItemState, setItemStage])

  /** The driver: keeps MAX_CONCURRENT_UPLOADS in flight until nothing is queued. */
  const drive = useCallback(async (target: UploadTarget) => {
    const token = await getToken()
    if (!token) return

    setRunning(true)
    abortRef.current = false

    // ── The overlay, ONCE for the whole run ──
    // Fetched and decoded before the first photo, reused by every one of them, released at
    // the end. Failing here aborts the run: storing unbranded photos for a branded event is
    // not recoverable, whereas a failed start is.
    let handle: Awaited<ReturnType<typeof prepareOverlay>> | null = null
    if (target.branding) {
      try {
        handle = await prepareOverlay({
          eventId: target.branding.eventId,
          style:   target.branding.style,
          token,
        })
      } catch (e) {
        const failure = classifyUploadError(e)
        setItems(prev => prev.map(it => it.state === 'queued'
          ? { ...it, state: 'failed' as UploadItemState, error: formatUploadFailure(failure), failure }
          : it))
        setRunning(false)
        return
      }
    }

    const timings = new UploadTimings()

    // ─── SLIDING WINDOW (RD-MEDIA-PERF-03) ─────────────────────────────────────
    // This used to be batch-and-barrier: take four, `Promise.all`, repeat. Every batch cost
    // its SLOWEST member, so with realistic size variance roughly a third of the wall clock
    // was spent with idle slots — and over 3,000 photos that is 750 barriers.
    //
    // Now a finished photo's slot is refilled immediately: `Promise.race` wakes as soon as
    // ANY in-flight photo settles.
    //
    // `dispatched` is not belt-and-braces. `itemsRef` is synced by an effect, so straight
    // after an await it can still describe a photo as `queued` that is already running —
    // which would dispatch it twice and upload it twice.
    const dispatched = new Set<string>()
    const inFlight   = new Set<Promise<void>>()

    const launch = (item: QueueItem) => {
      dispatched.add(item.id)
      const work = (async () => {
        try {
          await runItem(item, target, token, handle?.overlay ?? null, timings)
        } catch (e) {
          // Classified once, here, so the queue carries a cause rather than a string the
          // UI has to guess at.
          const failure = classifyUploadError(e)
          setItemState(item.id, 'fail', { error: formatUploadFailure(failure), failure })
        }
      })()
      const tracked: Promise<void> = work.finally(() => { inFlight.delete(tracked) })
      inFlight.add(tracked)
    }

    try {
      for (;;) {
        if (abortRef.current || pausedRef.current) break

        // Refill every free slot before waiting on anything.
        let pending = itemsRef.current.filter(
          i => i.state === 'queued' && !dispatched.has(i.id))
        while (inFlight.size < MAX_CONCURRENT_UPLOADS && pending.length > 0) {
          launch(pending[0])
          pending = pending.slice(1)
        }

        if (inFlight.size === 0) break
        // Wakes on the FIRST completion, not the last — this is the whole optimisation.
        await Promise.race([...inFlight])
      }
      // Let whatever is still running finish before the overlay is released.
      await Promise.allSettled([...inFlight])
    } finally {
      handle?.release()
      setRunning(false)
      reportTimings(timings)
    }
  }, [getToken, runItem, setItemState])

  /**
   * MS-FINAL-01 · The pre-flight duplicate scan. ONE hash pass, ONE request.
   *
   * Runs before slots are handed out, which is the whole point: a photo the organizer has
   * already uploaded must never open a session slot, reserve a credit or be charged for. It
   * does not have to be excluded explicitly — `assignSlots` only slots `queued` and `paused`
   * items, so moving a match into the existing `duplicate` state removes it from the batch
   * by itself.
   *
   * ═══ WHY THE HASH IS KEPT ═════════════════════════════════════════════════
   * Every byte is read and digested here. `processImage` would otherwise hash the same file
   * again during the upload, which over a large folder is minutes of CPU for an answer this
   * pass already has — so the digest is stored on the item and handed back.
   *
   * ═══ FAILURE IS NOT FATAL ═════════════════════════════════════════════════
   * If the scan cannot run, the upload proceeds. A duplicate that slips through costs one
   * duplicated photo; a scan failure that blocked the whole import would cost the organizer
   * their entire batch, and the scan is an assist, not a gate.
   */
  const scanDuplicates = useCallback(async (target: UploadTarget, token: string) => {
    const pending = itemsRef.current.filter(
      i => i.state === 'queued' && i.duplicateOf === null)
    if (pending.length === 0) return

    setScanning(true)
    try {
      // ── one hash pass ──
      const candidates: { itemId: string; checksum: string }[] = []
      const digests = new Map<string, string>()
      for (const it of pending) {
        try {
          const checksum = it.checksumPrecomputed
            ?? await hashBytes(await it.file.arrayBuffer())
          digests.set(it.id, checksum)
          candidates.push({ itemId: it.id, checksum })
        } catch {
          // An unreadable file is left to fail later, in the upload, where the error
          // machinery can classify it properly.
        }
      }
      if (candidates.length === 0) return

      // ── one request for the whole batch ──
      const res = await fetch(`${API}/uploads/duplicates`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ eventId: target.eventId, candidates }),
      })
      if (!res.ok) return                       // see the note above: an assist, not a gate
      const scan = await res.json() as DuplicateScan

      // An intra-batch repeat is a duplicate too — the organizer picked the same file twice,
      // or the folder holds a copy. The scanner already keeps the first occurrence fresh.
      const matched = new Map<string, DuplicateMatch['existing']>()
      for (const m of [...scan.matches, ...scan.intraBatch]) matched.set(m.itemId, m.existing)

      const next = itemsRef.current.map(it => {
        const checksum = digests.get(it.id) ?? it.checksumPrecomputed
        const hit      = matched.get(it.id)
        if (!hit) return checksum ? { ...it, checksumPrecomputed: checksum } : it
        const state = nextState(it.state, 'markDuplicate')
        return state
          ? { ...it, state, checksumPrecomputed: checksum ?? null, duplicateOf: hit }
          : it
      })
      // Written synchronously as well as through state: `ensureSlots` runs next and reads
      // `itemsRef`, and the effect that syncs it has not run yet.
      itemsRef.current = next
      setItems(next)
    } finally {
      setScanning(false)
    }
  }, [])

  /**
   * MC-10.2 · Gives every un-slotted queued photo a credit slot, under ONE new session.
   *
   * MC-10.4 · Shared by `start` AND `resume`. Resume needs it because photos can be added
   * to the queue while it is paused: those arrive with no slot, and dispatching them would
   * fail closed with HTTP 400 once credits are enabled. Items that already hold a slot are
   * skipped, so a resumed photo keeps the sessionId, slotIndex and derived assetId it
   * started with.
   */
  const ensureSlots = useCallback(() => {
    // A pure resume or retry assigns nothing, and the session id minted here is simply
    // discarded: the server opens a session lazily, on the first `prepare` that names it,
    // so an id that never reaches the server holds no credits and leaves nothing to reclaim.
    const assignments = assignSlots(itemsRef.current, newUploadSessionId())
    if (assignments.length === 0) return

    const byId = new Map(assignments.map(a => [a.id, a]))
    const apply = (list: QueueItem[]) => list.map(it => {
      const a = byId.get(it.id)
      return a
        ? { ...it, sessionId: a.sessionId, slotIndex: a.slotIndex, sessionSlots: a.sessionSlots }
        : it
    })
    // The ref is written synchronously as well as through state: the driver starts on the
    // next line and reads `itemsRef`, but the effect that syncs it has not run yet — without
    // this, every photo in the batch would be dispatched with a null slot and rejected.
    // Safe here because this runs from an event handler, not render.
    itemsRef.current = apply(itemsRef.current)
    setItems(apply)
  }, [])

  const start = useCallback((target: UploadTarget) => {
    pausedRef.current = false
    setPaused(false)
    targetRef.current = target

    // MS-FINAL-01 · Ordering is the whole feature: SCAN, then slot, then drive.
    //
    // Slots are credit allocations. Handing one to a photo about to be recognised as a
    // duplicate would reserve — and, once settled, charge for — a photo that never
    // uploads. Because the scan moves matches into the `duplicate` state and
    // `assignSlots` only slots `queued` and `paused` items,
    // the exclusion needs no special case.
    //
    // All three run inside ONE serial step, so a second Start cannot interleave its scan
    // with another run's slot assignment.
    void runSerially(async () => {
      const token = await getToken()
      if (token) await scanDuplicates(target, token)
      ensureSlots()
      await drive(target)
    })
  }, [drive, runSerially, ensureSlots, scanDuplicates, getToken])

  const pause = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
    setItems(prev => prev.map(it =>
      it.state === 'queued' ? { ...it, state: nextState('queued', 'pause') ?? it.state } : it))
  }, [])

  const resume = useCallback(() => {
    pausedRef.current = false
    setPaused(false)

    // MC-10.4 · Re-queue the parked photos, then RESTART THE DRIVER.
    //
    // The restart is the fix. `drive` does not pause — it exits: the dispatch loop breaks on
    // `pausedRef`, the remaining in-flight photos are awaited, and the function returns. So
    // clearing the flag and re-queueing, which is all this did before, left the items ready
    // and nobody to run them. Resume was clickable, changed state, and uploaded nothing.
    //
    // Items already `completed` are untouched: `drive` dispatches only `queued` ones, so
    // nothing re-uploads. Photos still in flight when Pause was pressed were never parked —
    // `pause` moves only `queued` items — so they ran to completion under the previous driver.
    const next = itemsRef.current.map(it =>
      it.state === 'paused' ? { ...it, state: nextState('paused', 'resume') ?? it.state } : it)
    // Written synchronously as well as through state, for the same reason `start` does it:
    // the driver reads `itemsRef` and the effect that syncs it has not run yet.
    itemsRef.current = next
    setItems(prev => prev.map(it =>
      it.state === 'paused' ? { ...it, state: nextState('paused', 'resume') ?? it.state } : it))

    // Photos can be added while the queue is paused, and those arrive with no slot. Existing
    // items are skipped, so nothing already in flight or already uploaded is renumbered.
    //
    // MS-FINAL-01 · Deliberately no duplicate re-scan. Resume continues a batch that was
    // already scanned; re-hashing every file to re-answer an answered question would make
    // Resume slower than Start for no benefit. A photo ADDED while paused is scanned on the
    // next Start — the same moment it would get a slot.
    ensureSlots()

    const target = targetRef.current
    // Null only if Resume were somehow reachable before a first Start. The button renders
    // only while paused, which requires a run, but a missing target must not throw.
    if (target) void runSerially(() => drive(target))
  }, [drive, runSerially, ensureSlots])

  const retryFailed = useCallback(() => {
    setItems(prev => prev.map(it =>
      it.state === 'failed'
        ? { ...it, state: nextState('failed', 'retry') ?? it.state, error: null, failure: null }
        : it))
  }, [])

  /**
   * MS-FINAL-01 · Applies one decision to every item currently in the `duplicate` state.
   *
   * Uses the machine's existing transitions — `resolveDuplicate` back to
   * `queued`, or `cancel` — so no new state and no new rule appears.
   * Items in any other state are untouched, which is what stops "skip all duplicates" from
   * cancelling the whole queue.
   *
   * An item re-queued here has no slot (it never got one), so the next Start assigns it one
   * like any other fresh photo.
   */
  const resolveDuplicates = useCallback((decision: 'upload' | 'skip') => {
    const action: QueueAction = decision === 'upload' ? 'resolveDuplicate' : 'cancel'
    const apply = (list: QueueItem[]) => list.map(it => {
      if (it.state !== 'duplicate') return it
      const next = nextState(it.state, action)
      // On 'upload' the match is cleared so the item is not re-flagged; on 'skip' it is
      // kept, because a cancelled row still has to explain itself in the queue.
      return next
        ? { ...it, state: next, duplicateOf: decision === 'upload' ? null : it.duplicateOf }
        : it
    })
    itemsRef.current = apply(itemsRef.current)
    setItems(apply)
  }, [])

  const cancelAll = useCallback(() => {
    abortRef.current = true
    setItems(prev => prev.map(it =>
      nextState(it.state, 'cancel') ? { ...it, state: 'cancelled' as UploadItemState } : it))

    // ── MC-10.6 · give the held credits back now ──────────────────────────────
    // Every session this queue touched. Usually one; two if a retry batch was mixed with new
    // photos. Sealing a session whose photos all completed is harmless — it settles for
    // exactly what was consumed, which is what the sweep would have done anyway.
    const sessionIds = [...new Set(
      itemsRef.current.map(i => i.sessionId).filter((id): id is string => Boolean(id)),
    )]
    if (sessionIds.length === 0) return

    // QUEUED BEHIND THE DRIVER, not fired immediately. Sealing is a barrier: a completion
    // that read the session inside its transaction is aborted by a seal, so sealing while
    // photos are still in flight would fail uploads that were about to succeed and leave
    // their bytes orphaned in storage. `cancelAll` sets `abortRef`, which stops the driver
    // dispatching, but it still awaits whatever is already running — chaining onto the same
    // runner means the seal lands exactly when that has finished (MC-10.4).
    setReleasing(true)
    void runSerially(async () => {
      try {
        const token = await getToken()
        if (!token) return
        // Independent: one failing session must not strand the others. A failure here is not
        // reported to the organizer either — the sweep is still the safety net, and the
        // credits return regardless, just later.
        await Promise.allSettled(sessionIds.map(id =>
          fetch(`${API_CREDITS}/sessions/${encodeURIComponent(id)}/release`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          })))
      } finally {
        setReleasing(false)
      }
    })
  }, [getToken, runSerially])

  const clear = useCallback(() => {
    abortRef.current = true
    setItems([])
  }, [])

  // RD-MEDIA-PERF-03: computed ONCE per items change, not on every render.
  //
  // These four ran in the hook body, so every consumer render allocated four arrays and made
  // four full passes over the queue. With three state updates per photo that is 9,000 renders
  // for a 3,000-photo import — the O(n²) the audit found.
  const derived = useMemo(() => {
    const states: UploadItemState[] = []
    const stages: (ProgressStage | null)[] = []
    const failures: UploadFailure[] = []
    for (const it of items) {
      states.push(it.state)
      stages.push(it.stage)
      if (it.failure) failures.push(it.failure)
    }
    return {
      progress: queueProgressPercent(states, stages),
      counts:   countByState(states),
      failures: summariseFailures(failures),
    }
  }, [items])

  return {
    items, running, paused, releasing, scanning,
    resolveDuplicates,
    progress: derived.progress,
    counts:   derived.counts,
    failures: derived.failures,
    add, start, pause, resume, retryFailed, cancelAll, clear,
  }
}
