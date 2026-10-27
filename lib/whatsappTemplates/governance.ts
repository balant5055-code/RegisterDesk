// RD-WA-TEMPLATES-01 — the template review mode. SERVER-ONLY.
//
// ONE source of truth: Business Configuration `integrations.whatsappTemplateReviewMode`.
// Changed only by PUT /api/admin/whatsapp-templates/governance (active Super Admin, reason required,
// versioned by businessConfig.updateSection with an admin-audit row staged in the same transaction).
//
// Safe default: if the configuration cannot be read, the mode is 'manual' — a Super Admin reviews
// before anything reaches Meta. 'automatic' is only ever the result of a deliberate, audited choice.

import { businessConfig } from '@/lib/config/businessConfigService'
import { parseReviewMode, DEFAULT_REVIEW_MODE, type ReviewMode } from './types'

export async function resolveReviewMode(): Promise<{ mode: ReviewMode; unavailable: boolean }> {
  try {
    const integrations = await businessConfig.getSection('integrations')
    return { mode: parseReviewMode((integrations as { whatsappTemplateReviewMode?: unknown }).whatsappTemplateReviewMode), unavailable: false }
  } catch {
    return { mode: DEFAULT_REVIEW_MODE, unavailable: true }
  }
}
