// RD-AI-01 · THE provider contract.
//
// SDK-FREE by contract. Nothing in this file may reference Gemini, OpenAI, Bedrock or any
// other vendor. If a signature ever needs a vendor concept to express itself, the
// abstraction has leaked and the fix belongs in the provider, not here.
//
// ═══ THIS SPRINT SHIPS NO IMPLEMENTATION ══════════════════════════════════════
// The interface and the registry exist; the registry is EMPTY. No provider file is written,
// no model is called, no prompt is sent. `providers/index.ts` documents how one is added.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── What a provider is, and is not ──────────────────────────────────────────
// A provider is a DUMB inference call. It takes one image reference and a kind, and returns
// a normalised payload.
//
// It does NOT:
//   • decide what to analyse            → services/aiQueue.ts
//   • decide when to retry              → queue/stateMachine.ts + utils/backoff.ts
//   • read or write Firestore           → repositories/
//   • fetch the image from storage      → services/dispatcher.ts (mints a signed URL)
//   • decide who may see the result     → the result's `visibility`, never the provider
//
// All of that lives ABOVE the provider so every provider inherits it identically and a new
// one cannot forget a policy — the same shape as `StorageProvider`.

import type { AIJobKind } from '@/features/ai/types'

/**
 * The image a provider is asked to look at.
 *
 * A provider NEVER receives bytes and NEVER receives storage credentials. It receives a
 * short-lived signed URL minted server-side by the dispatcher, so revoking access is a
 * matter of the URL expiring rather than of trusting a third party to forget something.
 */
export interface AIImageRef {
  assetId: string
  /** The storage KEY — for logging and provenance only; never fetchable by a provider. */
  key:     string
  /** Short-lived, server-minted, read-only. The only way in to the bytes. */
  signedUrl: string
  mimeType:  string
  width:     number | null
  height:    number | null
}

export interface AIAnalyzeInput {
  kind:  AIJobKind
  image: AIImageRef
  /** Capability-specific options. Opaque to the pipeline. */
  options?: Readonly<Record<string, unknown>>
  /**
   * Aborts the call when the pipeline's time budget expires. A provider that ignores this
   * will have its lease expire and its work duplicated, so honouring it is not optional.
   */
  signal?: AbortSignal
}

export interface AIAnalyzeOutput {
  /** Normalised, capability-specific. The pipeline stores it without reading inside. */
  payload: Readonly<Record<string, unknown>>
  /** 0–1 when the provider reports one, else null. */
  confidence: number | null
  /**
   * The model/API version that produced this — recorded on the job AND the result, so a
   * result can be invalidated when a model changes without guessing which ones are stale.
   */
  providerVersion: string | null
}

/**
 * The contract an AI provider implements.
 *
 * `analyze` MUST throw `AIError` (types/errors.ts) and never a vendor error, so the queue's
 * retry decision is made on a code it understands rather than on a string match.
 */
export interface AIProvider {
  /** Stable id, e.g. 'gemini'. Recorded on every job and result it serves. */
  readonly id: string

  /** Human name for diagnostics. */
  readonly name: string

  /**
   * True when the provider has everything it needs to run. Callers degrade gracefully
   * instead of throwing on a cold path — this never throws.
   *
   * Each provider validates its OWN configuration here, at its own boundary — the rule
   * `lib/env.ts` sets out (RD-ENV-ARCH-03) and platform-storage follows: a feature
   * misconfiguration must fail exactly that feature and nothing else.
   */
  isConfigured(): boolean

  /** Whether this provider can serve a kind. Cheap, synchronous, no I/O. */
  supports(kind: AIJobKind): boolean

  /** Every kind this provider can serve. Used to describe the pipeline honestly in the UI. */
  kinds(): readonly AIJobKind[]

  analyze(input: AIAnalyzeInput): Promise<AIAnalyzeOutput>
}
