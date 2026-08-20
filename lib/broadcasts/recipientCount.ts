// RD-BCAST-COUNT-01 · the recipient-count request, made honest.
//
// TWO DEFECTS THIS EXISTS TO KILL.
//
// 1. OUT-OF-ORDER RESPONSES. Switching the audience or the registration-date filter fires a
//    new count while the previous one is still in flight. Nothing sequenced them, so a
//    slower earlier request could land last and overwrite the newer number. Selecting
//    "Today" could therefore settle back to the unfiltered count — a filter that appears to
//    do nothing, with no error anywhere.
//
// 2. SILENT FAILURE. The old code updated state only `if (data.success)`, inside a try with
//    an empty catch. A failed request left the PREVIOUS number on screen, indistinguishable
//    from a fresh, correct one. A recipient count that is quietly stale is worse than none:
//    it is the number an organizer reads before deciding to send.
//
// Framework-free on purpose. The composer runs in a `node` test environment with no DOM, so
// logic that lives inside the component cannot be tested at all. Here it is directly
// exercisable — including the interleavings that caused the bug.

/** Window metadata echoed by the count endpoint when a date filter is active. */
export interface RecipientCountMeta {
  timezone:     string
  dateLabel:    string
  /**
   * Registrations the date filter structurally cannot reach.
   *
   * `null` means the server could not establish it — NOT zero. Zero is a claim that every
   * registration in this audience carries a usable `registeredAt`; null admits nobody
   * found out. Collapsing the two would show "no warning" for an unknown, which reads to
   * an organizer as reassurance that was never earned.
   */
  undatedCount: number | null
}

/**
 * What the UI is allowed to believe.
 *
 * `ready` with `count: 0` is a CONFIRMED zero and must render as "0 recipients".
 * `error` is "we do not know" and must never render as a number — least of all the
 * previous one. Keeping these distinct is the whole point of the type.
 */
export type RecipientCountState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; count: number; meta: RecipientCountMeta | null }
  | { status: 'error'; message: string }

export interface CountApiResponse {
  success:       boolean
  count?:        number
  error?:        string
  timezone?:     string
  dateLabel?:    string
  undatedCount?: number
}

export const COUNT_FAILED_MESSAGE = 'Could not calculate the recipient count. Check the filters and try again.'

/**
 * Maps one settled response to the state it actually justifies.
 *
 * A transport-level failure, `success: false`, or a missing or non-numeric `count` all yield
 * `error`. Note what is deliberately NOT done: an absent count is never coerced to 0. Zero
 * is a claim about the audience, and this function only makes claims the server made.
 */
export function toRecipientCountState(ok: boolean, body: CountApiResponse | null): RecipientCountState {
  if (!ok || !body || body.success !== true || typeof body.count !== 'number' || !Number.isFinite(body.count)) {
    return { status: 'error', message: (body && body.error) || COUNT_FAILED_MESSAGE }
  }
  return {
    status: 'ready',
    count:  body.count,
    meta:   body.timezone && body.dateLabel
      // `?? null`, never `?? 0`. A server-sent 0 stays 0; an absent or explicitly null
      // value stays unknown. Both "the field is missing" and "the diagnostic failed" mean
      // the same thing to a reader: we do not know.
      ? { timezone: body.timezone, dateLabel: body.dateLabel, undatedCount: body.undatedCount ?? null }
      : null,
  }
}

export interface RecipientCountController {
  /**
   * Runs one count request. `load` performs the transport; everything else — sequencing,
   * mapping, failure handling — happens here.
   */
  run(load: () => Promise<{ ok: boolean; body: CountApiResponse | null }>): Promise<void>
}

/**
 * Latest-wins controller. One per composer instance; the counter is closed over, so there
 * is no module-level or global state to leak between mounts or between tests.
 *
 * The guard is a monotonic id compared AFTER the await. Every state emission — ready, error,
 * and the initial loading — is gated on still being the newest request, so a superseded
 * response cannot touch the count, the window metadata, or the error.
 */
export function createRecipientCountController(
  onState: (state: RecipientCountState) => void,
): RecipientCountController {
  let latest = 0

  return {
    async run(load) {
      const id = ++latest
      onState({ status: 'loading' })

      let next: RecipientCountState
      try {
        const res = await load()
        next = toRecipientCountState(res.ok, res.body)
      } catch {
        // Network failure, aborted request, malformed JSON — all "we do not know".
        next = { status: 'error', message: COUNT_FAILED_MESSAGE }
      }

      // The decisive line. A response from a superseded request is discarded whether it
      // succeeded or failed; without this, an older "All registrations" result can land
      // after a newer "Today" result and silently restore the wrong number.
      if (id !== latest) return
      onState(next)
    },
  }
}
