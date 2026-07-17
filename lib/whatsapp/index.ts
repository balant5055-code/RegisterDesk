// Meta Cloud API (WhatsApp) provider factory — server-only.
//
// getMetaProvider() is the single entry point the Provider Resolver uses to
// discover the WhatsApp transport. Returns null when WhatsApp is not configured
// (the default) — no notification is routed here in Phase G3.1.

import { getMetaConfig } from './config'
import { MetaWhatsAppProvider, type WhatsAppProvider } from './provider'

// RD-CONF-12: async because the provider's non-secret policy (API version, request
// timeout) now comes from the Business Configuration `integrations` section. Built
// per call (not module-cached) so a config change applies within the 60s config
// TTL; construction is a cheap object assembly (no SDK/network). Returns null when
// WhatsApp is unconfigured (secrets absent). For a SYNC "is it configured?" check
// use isMetaConfigured() — that path is unchanged and stays synchronous.
export async function getMetaProvider(): Promise<WhatsAppProvider | null> {
  const config = await getMetaConfig()
  return config ? new MetaWhatsAppProvider(config) : null
}

export { isMetaConfigured, getWebhookVerifyToken } from './config'
export type { WhatsAppProvider, MetaHealthResult } from './provider'
export type {
  WhatsAppTemplateMessage,
  WhatsAppSendResult,
  WhatsAppParameter,
  WhatsAppButtonParameter,
} from './types'

// Template Registry — the single NotificationType → Meta template mapping.
// Exposed for discovery/resolution; NOT wired into the Notification Engine yet.
export {
  WHATSAPP_TEMPLATE_REGISTRY,
  WHATSAPP_TEMPLATE_REGISTRY_VERSION,
  hasWhatsAppTemplate,
  getWhatsAppTemplate,
  resolveWhatsAppTemplate,
  resolveWhatsAppTemplateByType,
} from './registry'
export type {
  WhatsAppTemplateDefinition,
  WhatsAppTemplateCategory,
  WhatsAppTemplateType,
  TemplateVariables,
  ResolveTemplateResult,
} from './registry'
