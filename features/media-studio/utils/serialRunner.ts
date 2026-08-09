// MC-10.4 · Run async tasks strictly one after another.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// The upload driver exits when the queue is paused, but it does not exit immediately: it
// stops dispatching, then awaits the photos already in flight before releasing the branding
// overlay. That wind-down can take seconds for large images.
//
// Pressing Resume inside that window used to be the difference between "nothing happens" and
// "two drivers run at once". Two drivers is the worse outcome: each keeps its own `dispatched`
// set, so both can pick up the same queued photo and upload it twice.
//
// Chaining removes the window entirely. A resume queued during wind-down simply waits for the
// previous driver to finish and then starts — no polling, no flag to get wrong, and no state
// in which two drivers exist.
//
// Deliberately a plain function rather than a hook: the vitest environment is `node` with no
// DOM, so this is the part of the fix that can actually be tested.

/** Queues `task` to run after every task queued before it. Resolves when `task` does. */
export type SerialRunner = (task: () => Promise<void>) => Promise<void>

export function createSerialRunner(): SerialRunner {
  let chain: Promise<void> = Promise.resolve()

  return task => {
    // `.catch` BEFORE `.then`: a task that throws must not poison the chain and strand every
    // later run. The driver already classifies and records its own failures, so a rejection
    // reaching here is exhausted — swallowing it loses nothing.
    const next = chain.catch(() => {}).then(task)
    // The stored link swallows too, so one failure cannot reject every future caller.
    chain = next.catch(() => {})
    return next
  }
}
