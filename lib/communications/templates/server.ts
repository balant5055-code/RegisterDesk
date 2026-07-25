// RD-PLATFORM-COMMS-01 Phase 4E — server aggregate for the Platform Template Center.
//
// Resolves every platform template by running each platform notification (from the canonical
// registry, Phase 4C) through the PURE template builder + health. Reuses the resolved registry
// (channel support) — no duplicated template state. Server-only. READ-ONLY.

import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'
import { buildTemplatesForNotification, templateHealth, type PlatformTemplate, type TemplateHealth } from './registry'
import { TEMPLATE_VARIABLES, type TemplateVariable } from './variables'

export interface TemplateCenterView {
  templates: (PlatformTemplate & { health: TemplateHealth })[]
  variables: TemplateVariable[]
}

export async function resolveTemplateCenter(): Promise<TemplateCenterView> {
  const registry = await resolveCommunicationRegistry()
  const templates = registry
    .flatMap(e => buildTemplatesForNotification(e, {
      email:    e.supports.email,
      whatsapp: e.supports.whatsapp,
      inapp:    e.supports.inapp,
    }))
    .map(t => ({ ...t, health: templateHealth(t) }))

  return { templates, variables: TEMPLATE_VARIABLES }
}
