// MC-05.6B · Per-organizer serialisation of wallet-touching work — SERVER ONLY.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Measured, not assumed. Running the credit path 4-wide is 3.4× SLOWER than running it
// serially, and 16-wide is 12× slower with 95% of transactions failing:
//
//     concurrency 1  → 10.6 photos/s,   0 failures,  p95   111ms
//     concurrency 4  →  3.1 photos/s,   1 failure,   p95  8284ms
//     concurrency 16 →  0.9 photos/s, 189 failures,  p95 16897ms
//
// That is not a throughput ceiling — it is optimistic-concurrency LIVELOCK. Every credit
// transaction reads `mediaCreditWallets/{uid}` and then writes it, so concurrent callers
// abort each other and retry with backoff. Adding concurrency adds aborts, not throughput.
//
// The fix is therefore not to make the wallet faster. It is to stop competing for it.
// Queueing here converts a retry storm into an orderly line, which the measurement shows is
// strictly faster AND removes the failures.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// NOT a distributed lock, and deliberately so. A lock document in Firestore would be exactly
// the hot document this exists to relieve. This serialises within ONE server instance.
//
// On a serverless deployment several instances may serve one organizer's uploads, so the
// guarantee is partial: contention is reduced by roughly the number of requests that share
// an instance, not eliminated. That is an honest limitation, and the failure mode is
// GRACEFUL — with no sharing at all, behaviour is exactly what it is today, never worse.
//
// ═══ CORRECTNESS IS NOT AFFECTED ═════════════════════════════════════════════
// This changes only the ORDER work is attempted in, never its outcome. Firestore
// transactions remain the sole correctness mechanism: every guarantee — atomicity,
// idempotency, the overdraft check, the ledger invariant — holds identically whether or not
// a caller queued first. Remove this file and the system is still correct, only slower.

/** In-flight chain per organizer. Deleted when it drains, so this cannot grow unbounded. */
const chains = new Map<string, Promise<unknown>>()

/**
 * Failsafe. A queued operation that never settles must not block an organizer forever, so
 * the chain advances after this long regardless of whether the holder finished.
 *
 * Generous relative to a credit transaction (p50 ~90ms, worst measured ~25s under the
 * contention this removes). Exceeding it means something is badly wrong, and letting the
 * next caller through is safer than freezing the queue — Firestore still guarantees the
 * outcome either way.
 */
export const LOCK_TIMEOUT_MS = 30_000

/** Resolves after `ms`, regardless of what the tracked promise does. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    // `unref` where available so a pending timer cannot hold a process open.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    void p.then(() => { clearTimeout(timer); resolve() },
                () => { clearTimeout(timer); resolve() })
  })
}

/**
 * Runs `fn` after any work already queued for `organizerUid`, and returns its result.
 *
 * Rejections propagate to the caller unchanged — queueing must not swallow a failure — while
 * the internal chain absorbs them so one failed operation cannot poison the queue behind it.
 *
 * Reentrancy warning: `fn` must not itself call `withOrganizerLock` for the same organizer.
 * Nothing in this module does; the lock is applied at the outermost wallet-touching call.
 */
export async function withOrganizerLock<T>(
  organizerUid: string, fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(organizerUid) ?? Promise.resolve()

  let release!: () => void
  const gate = new Promise<void>(r => { release = r })

  // The chain a later caller will wait on. Bounded so a hung holder cannot freeze the line.
  const link = previous.then(() => settleWithin(gate, LOCK_TIMEOUT_MS))
  chains.set(organizerUid, link)

  await previous.catch(() => { /* a predecessor's failure is not this caller's problem */ })

  try {
    return await fn()
  } finally {
    release()
    // Drop the key once this link is the tail and has drained, so the map tracks only
    // organizers with work in flight.
    void link.then(() => {
      if (chains.get(organizerUid) === link) chains.delete(organizerUid)
    })
  }
}

/** Organizers with work queued or in flight. Diagnostics only. */
export function inFlightOrganizers(): number {
  return chains.size
}
