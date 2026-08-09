// RD-AI-01 · Prompt registry.
//
// PURE. No SDK, no I/O.
//
// ═══ NO PROMPT EXISTS ═════════════════════════════════════════════════════════
// This sprint writes NO prompt text. `PROMPTS` is empty, and a repo-wide search for
// instruction text aimed at a model finds nothing. What exists here is the SLOT: the
// versioning contract a prompt must satisfy when one is eventually written.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── Why prompts are versioned data, not string literals in a provider ───────
// A prompt is the other half of a model's behaviour. If it lives inline in a provider, two
// results produced months apart are not comparable and there is no way to answer "which
// prompt produced this?" after an edit. Registering it with an explicit version means a
// result records `promptId` + `promptVersion` and stays explicable.

import type { AIJobKind } from '@/features/ai/types'

export interface PromptTemplate {
  /** Stable id, e.g. 'bib-detect'. Recorded on any result it produced. */
  id: string
  /** Bumped on EVERY text change, however small. Never edit a version in place. */
  version: number
  /** The kind this prompt serves. */
  kind: AIJobKind
  /**
   * The provider this text is tuned for, or null when it is provider-neutral. Prompts are
   * rarely portable, so a provider-specific variant is the normal case.
   */
  providerId: string | null
  /** The instruction sent to the model. */
  text: string
}

/** EMPTY — see the header. */
const PROMPTS: readonly PromptTemplate[] = []

export function allPrompts(): readonly PromptTemplate[] {
  return PROMPTS
}

/**
 * The prompt for a kind, preferring a provider-specific variant over a neutral one.
 * Returns null when none is registered — which is every call, in this sprint.
 */
export function getPrompt(kind: AIJobKind, providerId?: string | null): PromptTemplate | null {
  const forKind = PROMPTS.filter(p => p.kind === kind)
  if (forKind.length === 0) return null
  if (providerId) {
    const specific = forKind.find(p => p.providerId === providerId)
    if (specific) return specific
  }
  return forKind.find(p => p.providerId === null) ?? null
}

/** `bib-detect@3` — the form recorded alongside a result. */
export function promptRef(prompt: PromptTemplate): string {
  return `${prompt.id}@${prompt.version}`
}
