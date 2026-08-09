// RD-AI-01 · Result consumers.
//
// PURE registry. No SDK, no I/O — it holds references, it never calls one.
//
// ─── Why a registry and not an `if` ──────────────────────────────────────────
// A result has to become something: a bib link, a tag, a caption. The naive way to arrange
// that is `if (job.kind === 'bib-detect') …` inside the dispatcher, which puts a capability's
// name in generic code and guarantees a growing chain of them. RD-MEDIA-02 was an entire
// sprint spent removing exactly that shape from Media Studio.
//
// So the dispatcher knows only that a kind MAY have a consumer, and a capability registers
// itself in ONE assembly file (`features/ai/bootstrap.ts`). Adding a capability touches
// that file and nothing else in the pipeline.

import type { AIJobDoc, AIJobKind, AIResultDoc } from '@/features/ai/types'

export interface AIResultContext {
  job:    AIJobDoc
  result: AIResultDoc
}

/**
 * Turns a stored result into whatever its capability means.
 *
 * MUST be idempotent: it runs after the job is already `completed`, so a re-run is a normal
 * recovery path rather than an exception.
 */
export type AIResultConsumer = (ctx: AIResultContext) => Promise<void>

const consumers = new Map<AIJobKind, AIResultConsumer>()

export function registerResultConsumer(kind: AIJobKind, consumer: AIResultConsumer): void {
  consumers.set(kind, consumer)
}

export function getResultConsumer(kind: AIJobKind): AIResultConsumer | null {
  return consumers.get(kind) ?? null
}

export function registeredConsumerKinds(): AIJobKind[] {
  return [...consumers.keys()].sort()
}

/** Test-affordance. */
export function resetResultConsumers(): void {
  consumers.clear()
}
