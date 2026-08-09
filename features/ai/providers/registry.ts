// RD-AI-01 · Provider registry.
//
// PURE. No SDK, no I/O — it holds references, it never calls one.
//
// ═══ EMPTY BY DESIGN ══════════════════════════════════════════════════════════
// `BUILT_IN_PROVIDERS` is an empty list. Sprint 8 builds the pipeline and implements NO
// provider, so `resolveProvider()` returns null and the queue reports itself as not
// configured. That is the honest state, and it is provable: a repo-wide search finds no
// Gemini, OpenAI or Bedrock SDK.
// ══════════════════════════════════════════════════════════════════════════════

import type { AIJobKind } from '@/features/ai/types'
import type { AIProvider } from '@/features/ai/providers/AIProvider'

/**
 * Provider ids the platform intends to support.
 *
 * A NAME LIST, not an implementation list — it exists so ids are spelled one way in logs,
 * documents and configuration. Registration does not consult it: a provider outside this
 * list registers fine, because forcing a core edit to add one would defeat the module.
 */
export const KNOWN_AI_PROVIDER_IDS = ['gemini', 'openai', 'aws'] as const
export type KnownAIProviderId = typeof KNOWN_AI_PROVIDER_IDS[number]

/**
 * Providers compiled into the platform.
 *
 * Adding one is two steps and touches nothing else:
 *   1. implement `AIProvider` in `providers/<vendor>/<Vendor>Provider.ts`
 *   2. add it here
 * No queue change, no repository change, no route change. That is the entire point.
 */
const BUILT_IN_PROVIDERS: readonly AIProvider[] = []

/** Registered at runtime (tests, and any future deployment-specific provider). */
const runtimeProviders = new Map<string, AIProvider>()

export function registerProvider(provider: AIProvider): void {
  runtimeProviders.set(provider.id, provider)
}

/**
 * Removes a runtime registration. Test-affordance — built-ins are unaffected, so this can
 * never be used to disable a provider in production by accident.
 */
export function unregisterProvider(id: string): void {
  runtimeProviders.delete(id)
}

/** Clears every runtime registration. Test-affordance. */
export function resetRuntimeProviders(): void {
  runtimeProviders.clear()
}

/** Every provider currently known, built-in first. */
export function allProviders(): AIProvider[] {
  const byId = new Map<string, AIProvider>()
  for (const p of BUILT_IN_PROVIDERS) byId.set(p.id, p)
  for (const [id, p] of runtimeProviders) byId.set(id, p)
  return [...byId.values()]
}

/** Providers that are both registered AND configured. */
export function configuredProviders(): AIProvider[] {
  return allProviders().filter(p => {
    // A provider whose isConfigured() throws is treated as unconfigured rather than being
    // allowed to take the whole pipeline down on a cold path.
    try { return p.isConfigured() } catch { return false }
  })
}

export function getProviderById(id: string): AIProvider | null {
  return allProviders().find(p => p.id === id) ?? null
}

/**
 * The provider that will serve a kind, or null.
 *
 * FIRST configured match wins, in registration order. Deliberately not "best" or
 * "cheapest": a scoring rule would need cost and quality data the platform does not have,
 * and a deterministic order is something an operator can reason about.
 */
export function resolveProvider(kind: AIJobKind): AIProvider | null {
  return configuredProviders().find(p => {
    try { return p.supports(kind) } catch { return false }
  }) ?? null
}

/** Every kind any configured provider can serve — how the UI describes the pipeline. */
export function supportedKinds(): string[] {
  const kinds = new Set<string>()
  for (const p of configuredProviders()) {
    try { for (const k of p.kinds()) kinds.add(k) } catch { /* a broken provider contributes nothing */ }
  }
  return [...kinds].sort()
}

/** True when at least one provider is registered and configured. */
export function isPipelineConfigured(): boolean {
  return configuredProviders().length > 0
}
