// RD-AI-01 — the AI queue state machine.
//
// An AI job costs money per attempt, so the properties that matter are not "does it move
// forward" but "can it move forward TWICE". These tests pin the closure of the machine, the
// terminal states, cancellation, and the claim gate that stops two dispatchers paying for
// the same inference.

import { describe, it, expect } from 'vitest'
import {
  attemptsRemaining, canTransition, decideFailureAction, isCancellable, isClaimable,
  isDue, isTerminal, nextStatus, type AIQueueAction,
} from '@/features/ai/queue/stateMachine'
import { AI_JOB_STATUSES, type AIJobStatus } from '@/features/ai/types'

const ALL_ACTIONS: AIQueueAction[] =
  ['claim', 'succeed', 'scheduleRetry', 'fail', 'expireLease', 'cancel', 'requeue']

// ═══════════════ The machine is closed ═══════════════

describe('the machine is closed, not permissive', () => {
  it('every legal transition lands on a real status', () => {
    for (const from of AI_JOB_STATUSES) {
      for (const action of ALL_ACTIONS) {
        const to = nextStatus(from, action)
        if (to !== null) expect(AI_JOB_STATUSES).toContain(to)
      }
    }
  })

  it('canTransition and nextStatus never disagree', () => {
    for (const from of AI_JOB_STATUSES) {
      for (const action of ALL_ACTIONS) {
        expect(canTransition(from, action)).toBe(nextStatus(from, action) !== null)
      }
    }
  })

  it('refuses an action that is not legal from a state', () => {
    expect(nextStatus('queued', 'succeed')).toBeNull()
    expect(nextStatus('queued', 'scheduleRetry')).toBeNull()
    expect(nextStatus('completed', 'requeue')).toBeNull()
    expect(nextStatus('retry', 'succeed')).toBeNull()
  })
})

// ═══════════════ Terminal states ═══════════════

describe('terminal states', () => {
  it('nothing can move a completed or cancelled job', () => {
    for (const action of ALL_ACTIONS) {
      expect(nextStatus('completed', action), `completed + ${action}`).toBeNull()
      expect(nextStatus('cancelled', action), `cancelled + ${action}`).toBeNull()
    }
  })

  it('reports exactly completed and cancelled as terminal', () => {
    const terminal = AI_JOB_STATUSES.filter(isTerminal)
    expect([...terminal].sort()).toEqual(['cancelled', 'completed'])
  })

  it('failed is NOT terminal — a human may requeue it', () => {
    expect(isTerminal('failed')).toBe(false)
    expect(nextStatus('failed', 'requeue')).toBe('queued')
  })

  it('but the pipeline itself can never requeue: requeue is illegal from every other state', () => {
    for (const from of AI_JOB_STATUSES) {
      if (from === 'failed') continue
      expect(nextStatus(from, 'requeue'), `requeue from ${from}`).toBeNull()
    }
  })
})

// ═══════════════ The happy path and the retry loop ═══════════════

describe('lifecycle', () => {
  it('queued → running → completed', () => {
    const running = nextStatus('queued', 'claim')
    expect(running).toBe('running')
    expect(nextStatus(running as AIJobStatus, 'succeed')).toBe('completed')
  })

  it('a retry cycles back through running, not straight to completed', () => {
    expect(nextStatus('running', 'scheduleRetry')).toBe('retry')
    expect(nextStatus('retry', 'claim')).toBe('running')
  })

  it('a dead worker releases its job to retry, not to failed', () => {
    // The lease expiring means nobody knows what happened — that is recoverable, and
    // failing the job outright would strand work no human asked to stop.
    expect(nextStatus('running', 'expireLease')).toBe('retry')
  })

  it('a job can be failed before it ever runs (its asset was deleted underneath it)', () => {
    expect(nextStatus('queued', 'fail')).toBe('failed')
    expect(nextStatus('retry',  'fail')).toBe('failed')
  })
})

// ═══════════════ Cancellation ═══════════════

describe('cancellation', () => {
  it('is possible from every non-terminal state', () => {
    for (const from of AI_JOB_STATUSES) {
      expect(isCancellable(from), `cancel from ${from}`).toBe(!isTerminal(from))
    }
  })

  it('always lands on cancelled', () => {
    for (const from of AI_JOB_STATUSES) {
      if (isTerminal(from)) continue
      expect(nextStatus(from, 'cancel')).toBe('cancelled')
    }
  })

  it('a cancelled job is never claimable again — cancelling is a human decision', () => {
    expect(isClaimable('cancelled')).toBe(false)
    expect(nextStatus('cancelled', 'claim')).toBeNull()
  })
})

// ═══════════════ Failure policy ═══════════════

describe('decideFailureAction', () => {
  it('retries while the budget lasts', () => {
    expect(decideFailureAction({ attempt: 1, maxAttempts: 3, retryable: true })).toBe('scheduleRetry')
    expect(decideFailureAction({ attempt: 2, maxAttempts: 3, retryable: true })).toBe('scheduleRetry')
  })

  it('gives up on the last attempt', () => {
    expect(decideFailureAction({ attempt: 3, maxAttempts: 3, retryable: true })).toBe('fail')
    expect(decideFailureAction({ attempt: 9, maxAttempts: 3, retryable: true })).toBe('fail')
  })

  it('never retries a non-retryable error, however much budget is left', () => {
    // Retrying a rejected image burns provider quota and delays the honest answer.
    expect(decideFailureAction({ attempt: 1, maxAttempts: 10, retryable: false })).toBe('fail')
  })

  it('attemptsRemaining never goes negative', () => {
    expect(attemptsRemaining(1, 3)).toBe(2)
    expect(attemptsRemaining(3, 3)).toBe(0)
    expect(attemptsRemaining(7, 3)).toBe(0)
  })
})

// ═══════════════ The claim gate ═══════════════

describe('isDue — the gate that stops paying twice', () => {
  const now = 1_000_000

  it('a queued job with no lease is due', () => {
    expect(isDue({ status: 'queued', nextAttemptAt: null, lockedUntilMs: null, now })).toBe(true)
  })

  it('refuses a job another worker holds', () => {
    expect(isDue({ status: 'queued', nextAttemptAt: null, lockedUntilMs: now + 1, now })).toBe(false)
  })

  it('allows a job whose lease has expired — that is how a dead worker is recovered', () => {
    expect(isDue({ status: 'queued', nextAttemptAt: null, lockedUntilMs: now - 1, now })).toBe(true)
  })

  it('holds a retrying job until its backoff elapses', () => {
    expect(isDue({ status: 'retry', nextAttemptAt: now + 1, lockedUntilMs: null, now })).toBe(false)
    expect(isDue({ status: 'retry', nextAttemptAt: now,     lockedUntilMs: null, now })).toBe(true)
    expect(isDue({ status: 'retry', nextAttemptAt: now - 1, lockedUntilMs: null, now })).toBe(true)
  })

  it('never offers a running, completed, failed or cancelled job', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled'] as AIJobStatus[]) {
      expect(isDue({ status, nextAttemptAt: null, lockedUntilMs: null, now }), status).toBe(false)
    }
  })

  it('a lease beats an elapsed backoff — both gates must pass', () => {
    expect(isDue({ status: 'retry', nextAttemptAt: now - 5000, lockedUntilMs: now + 5000, now })).toBe(false)
  })

  it('agrees with isClaimable about which statuses are eligible at all', () => {
    for (const status of AI_JOB_STATUSES) {
      const due = isDue({ status, nextAttemptAt: null, lockedUntilMs: null, now })
      expect(due, status).toBe(isClaimable(status))
    }
  })
})
