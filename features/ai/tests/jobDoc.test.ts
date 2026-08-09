// RD-AI-01 — the persistence shapes.
//
// These are the parts of the repository that have no I/O: the deterministic id that makes
// enqueueing idempotent, the document a new job starts as, and the projection that crosses
// the wire. Kept out of `aiJobRepo.ts` on purpose — importing that file boots the Admin SDK,
// and a shape a security boundary depends on has to be testable.

import { describe, it, expect } from 'vitest'
import {
  aiJobId, aiResultId, buildNewJob, serializeAiJob, toQueueSummary,
} from '@/features/ai/utils/jobDoc'
import { AI_PIPELINE_VERSION, AI_SCHEMA_VERSION, type AIJobDoc } from '@/features/ai/types'
import { DEFAULT_MAX_ATTEMPTS } from '@/features/ai/utils/backoff'
import { isAIError } from '@/features/ai/types/errors'

const INPUT = {
  organizerUid: 'org_1',
  eventId:      'evt_1',
  eventSlug:    'mumbai-marathon-2026',
  assetId:      'med_abc123',
  galleryId:    'gal_1',
  albumId:      null,
  kind:         'fake-analysis',
  createdBy:    'user_1',
}

// ═══════════════ Identity ═══════════════

describe('aiJobId', () => {
  it('is deterministic — the same analysis of the same photo is ONE job', () => {
    // This is what makes a re-run of a batch, or a retried request after a dropped
    // response, harmless instead of a second inference charge.
    expect(aiJobId('med_abc', 'kind')).toBe(aiJobId('med_abc', 'kind'))
  })

  it('separates kinds and assets', () => {
    expect(aiJobId('med_abc', 'k1')).not.toBe(aiJobId('med_abc', 'k2'))
    expect(aiJobId('med_abc', 'kind')).not.toBe(aiJobId('med_xyz', 'kind'))
  })

  it('never produces a value Firestore would read as a path', () => {
    expect(aiJobId('med_abc', 'fake-analysis')).not.toContain('/')
  })

  it('refuses an assetId that would escape its document', () => {
    expect(() => aiJobId('med/../other', 'kind')).toThrow()
    expect(() => aiJobId('', 'kind')).toThrow()
  })

  it('refuses a malformed kind', () => {
    for (const kind of ['', 'A', 'Has Spaces', '-leading', '1digit', 'x'.repeat(41), '../esc']) {
      expect(() => aiJobId('med_abc', kind), kind).toThrow()
    }
  })

  it('throws an AIError, so a route maps it to a status without a string match', () => {
    try { aiJobId('med_abc', 'BAD KIND'); expect.unreachable() }
    catch (e) { expect(isAIError(e)).toBe(true) }
  })

  it('a result shares its job id — one current result per (asset, kind)', () => {
    const id = aiJobId('med_abc', 'kind')
    expect(aiResultId(id)).toBe(id)
  })
})

// ═══════════════ The new-job document ═══════════════

describe('buildNewJob', () => {
  it('starts queued, unattempted and unattributed', () => {
    const job = buildNewJob(INPUT)
    expect(job.status).toBe('queued')
    expect(job.attempt).toBe(0)
    expect(job.nextAttemptAt).toBeNull()
    expect(job.resultId).toBeNull()
    expect(job.error).toBeNull()
    expect(job.durationMs).toBeNull()
  })

  it('records NO provider at enqueue time', () => {
    // Which provider serves a kind can change between enqueue and execution; recording an
    // intention here would be a lie the moment the registry changed. The job records what
    // actually ran it, at claim time.
    const job = buildNewJob(INPUT)
    expect(job.providerId).toBeNull()
    expect(job.providerVersion).toBeNull()
  })

  it('stamps both versions', () => {
    const job = buildNewJob(INPUT)
    expect(job.schemaVersion).toBe(AI_SCHEMA_VERSION)
    expect(job.pipelineVersion).toBe(AI_PIPELINE_VERSION)
  })

  it('defaults and clamps the attempt budget', () => {
    expect(buildNewJob(INPUT).maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS)
    expect(buildNewJob({ ...INPUT, maxAttempts: 7 }).maxAttempts).toBe(7)
    expect(buildNewJob({ ...INPUT, maxAttempts: 9999 }).maxAttempts).toBe(10)
    expect(buildNewJob({ ...INPUT, maxAttempts: 0 }).maxAttempts).toBe(1)
  })

  it('carries the tenant key — every read is scoped by it', () => {
    expect(buildNewJob(INPUT).organizerUid).toBe('org_1')
  })

  it('refuses a job with no tenant, event or author', () => {
    for (const field of ['organizerUid', 'eventId', 'eventSlug', 'galleryId', 'createdBy'] as const) {
      expect(() => buildNewJob({ ...INPUT, [field]: '' }), field).toThrow()
      expect(() => buildNewJob({ ...INPUT, [field]: '   ' }), field).toThrow()
    }
  })

  it('sets no timestamp — only the server may mint one', () => {
    const job = buildNewJob(INPUT) as Record<string, unknown>
    for (const field of ['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'lockedUntil']) {
      expect(job[field], field).toBeUndefined()
    }
  })

  it('links a batch when it came from one', () => {
    expect(buildNewJob(INPUT).batchId).toBeNull()
    expect(buildNewJob({ ...INPUT, batchId: 'gal_1__kind' }).batchId).toBe('gal_1__kind')
  })
})

// ═══════════════ The wire shape ═══════════════

const DOC: AIJobDoc = {
  ...buildNewJob(INPUT),
  status:     'completed',
  attempt:    2,
  providerId: 'fake',
  providerVersion: 'fake-1',
  durationMs: 1234,
  resultId:   'med_abc123__fake-analysis',
  nextAttemptAt: 1_700_000_000_000,
  lockedUntil: null,
  createdAt:   { toDate: () => new Date('2026-07-01T10:00:00.000Z') },
  startedAt:   { toDate: () => new Date('2026-07-01T10:00:05.000Z') },
  completedAt: { toDate: () => new Date('2026-07-01T10:00:06.234Z') },
  updatedAt:   null,
}

describe('serializeAiJob', () => {
  it('turns every Firestore Timestamp into an ISO string', () => {
    const view = serializeAiJob(DOC)
    expect(view.createdAt).toBe('2026-07-01T10:00:00.000Z')
    expect(view.startedAt).toBe('2026-07-01T10:00:05.000Z')
    expect(view.completedAt).toBe('2026-07-01T10:00:06.234Z')
  })

  it('renders the backoff instant as a time, not a number', () => {
    expect(serializeAiJob(DOC).nextAttemptAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(serializeAiJob({ ...DOC, nextAttemptAt: null }).nextAttemptAt).toBeNull()
  })

  it('survives a missing or malformed timestamp instead of throwing', () => {
    const view = serializeAiJob({ ...DOC, createdAt: undefined, startedAt: 42, completedAt: null })
    expect(view.createdAt).toBeNull()
    expect(view.startedAt).toBeNull()
    expect(view.completedAt).toBeNull()
  })

  it('exposes the provenance an organizer needs to judge a result', () => {
    const view = serializeAiJob(DOC)
    expect(view.providerId).toBe('fake')
    expect(view.providerVersion).toBe('fake-1')
    expect(view.pipelineVersion).toBe(AI_PIPELINE_VERSION)
    expect(view.durationMs).toBe(1234)
    expect(view.attempt).toBe(2)
  })

  it('NEVER carries the tenant key, the event id or the author', () => {
    // Organizer-facing, but the habit that keeps a projection from drifting public.
    const view = serializeAiJob(DOC) as unknown as Record<string, unknown>
    for (const field of ['organizerUid', 'eventId', 'createdBy', 'batchId', 'schemaVersion']) {
      expect(view[field], field).toBeUndefined()
    }
  })
})

// ═══════════════ Summaries ═══════════════

describe('toQueueSummary', () => {
  it('folds counts and totals them', () => {
    const s = toQueueSummary({ queued: 3, running: 1, completed: 10, failed: 2 })
    expect(s.queued).toBe(3)
    expect(s.completed).toBe(10)
    expect(s.total).toBe(16)
  })

  it('ignores a status it does not recognise rather than inventing a bucket', () => {
    const s = toQueueSummary({ queued: 1, nonsense: 99 })
    expect(s.queued).toBe(1)
    expect(s.total).toBe(1)
  })

  it('never reports a negative or fractional count', () => {
    const s = toQueueSummary({ queued: -5, running: 2.7, failed: NaN })
    expect(s.queued).toBe(0)
    expect(s.running).toBe(2)
    expect(s.failed).toBe(0)
  })

  it('an empty queue is all zeros', () => {
    expect(toQueueSummary({}).total).toBe(0)
  })
})
