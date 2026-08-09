// RD-AI-01 · Providers — the sub-module's surface.
//
// ─── Adding a provider ───────────────────────────────────────────────────────
//   1. Create `providers/<vendor>/<Vendor>Provider.ts` implementing `AIProvider`.
//   2. Read its secrets through `optional()` in `lib/env.ts` and validate them in the
//      provider's OWN config file — never at app boot (RD-ENV-ARCH-03). A missing key must
//      fail AI and nothing else.
//   3. Translate every vendor error into an `AIError` with a code the queue understands.
//      A raw vendor error escaping the provider is a bug in that provider.
//   4. Add it to `BUILT_IN_PROVIDERS` in `registry.ts`.
//
// Nothing above the provider changes. No queue edit, no repository edit, no route edit.
//
// ─── Rules a provider must obey ──────────────────────────────────────────────
//   • It receives a short-lived signed URL, never bytes and never storage credentials.
//   • It never writes Firestore and never decides visibility.
//   • It never receives an asset that is not an event photo — the dispatcher will not mint
//     a URL for a certificate or a report.
//   • No secret is ever exported to the client. A provider is SERVER-ONLY; importing one
//     from a client component would put its key in the browser bundle.

export type {
  AIProvider, AIAnalyzeInput, AIAnalyzeOutput, AIImageRef,
} from './AIProvider'

export {
  KNOWN_AI_PROVIDER_IDS, allProviders, configuredProviders, getProviderById,
  isPipelineConfigured, registerProvider, resetRuntimeProviders, resolveProvider,
  supportedKinds, unregisterProvider,
} from './registry'
export type { KnownAIProviderId } from './registry'
