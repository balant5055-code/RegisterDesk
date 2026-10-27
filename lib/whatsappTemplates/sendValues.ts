// RD-WA-TEMPLATES-01 — the values an organizer template is sent with, and the message itself.
// SERVER-ONLY. Used by the broadcast create route (to refuse a campaign that could not be filled)
// and by the WhatsApp broadcast job (to send).
//
// Every automatic value comes from the SAME sources the existing broadcasts use: the event document
// (authoritativeEventName, broadcastEventVars), the organizer's public branding, the deployment's
// canonical origin for the certificate link, and the recipient snapshot. Organizer-typed values are
// only the template's own broadcast-time variables (validateCampaignValues).

import { adminDb } from '@/lib/firebase/admin'
import { resolvePublicBranding } from '@/lib/branding/service'
import { broadcastEventVars } from '@/lib/broadcasts/eventVars'
import { authoritativeEventName } from '@/lib/broadcasts/eventName'
import { getEmailAppUrl } from '@/lib/email/appUrl'
import type { WhatsAppTemplateMessage, WhatsAppParameter } from '@/lib/whatsapp/types'
import { catalogVariable } from './types'
import type { SendableTemplate } from './service'

export interface TemplateEventValues {
  values:    Record<string, string>
  eventType: string | null
}

/** Event-sourced variable values for one event (the event document must belong to organizerUid). */
export async function templateEventValues(organizerUid: string, eventSlug: string, eventDoc?: Record<string, unknown> | null): Promise<TemplateEventValues> {
  const [doc, branding, orgSnap] = await Promise.all([
    eventDoc !== undefined ? Promise.resolve(eventDoc) : adminDb.collection('events').doc(eventSlug).get().then(s => (s.exists ? s.data() as Record<string, unknown> : null)).catch(() => null),
    resolvePublicBranding(organizerUid).catch(() => null),
    adminDb.collection('users').doc(organizerUid).get().catch(() => null),
  ])
  const org = (orgSnap?.data() ?? {}) as { organizationName?: unknown; name?: unknown }
  const organizerName = branding?.companyName
    || (typeof org.organizationName === 'string' ? org.organizationName : '')
    || (typeof org.name === 'string' ? org.name : '')
  const ev = broadcastEventVars(doc, organizerName)
  return {
    values: {
      eventName: authoritativeEventName(doc, eventSlug),
      eventDate: ev.eventDate, eventLocation: ev.eventLocation, organizerName: ev.organizerName,
      certificateUrl: `${getEmailAppUrl()}/events/${eventSlug}/certificates`,
    },
    eventType: doc && typeof doc.eventType === 'string' ? doc.eventType : null,
  }
}

/** Variables the template uses that this event's type does not provide (e.g. a bib number at a conference). */
export function variablesUnavailableForEvent(t: Pick<SendableTemplate, 'bodyOrder' | 'headerOrder'>, eventType: string | null): string[] {
  return [...new Set([...t.headerOrder, ...t.bodyOrder])].filter(k => {
    const c = catalogVariable(k)
    return !!c?.eventTypes && !(eventType && c.eventTypes.includes(eventType))
  })
}

export type BuiltMessage = { ok: true; message: WhatsAppTemplateMessage } | { ok: false; error: string; missing: string[] }

/**
 * The Meta message for one recipient. Every positional parameter must have a non-empty value —
 * Meta refuses an empty one — so a recipient missing e.g. a bib number is reported, never sent blank.
 */
export function buildTemplateMessage(t: Pick<SendableTemplate, 'metaName' | 'language' | 'bodyOrder' | 'headerOrder'>, to: string, vars: Record<string, string>): BuiltMessage {
  if (!to?.trim()) return { ok: false, error: 'Missing recipient phone number', missing: [] }
  const missing = [...new Set([...t.headerOrder, ...t.bodyOrder])].filter(k => !(vars[k] ?? '').trim())
  if (missing.length) return { ok: false, error: `Missing required variables: ${missing.join(', ')}`, missing }
  const param = (k: string): WhatsAppParameter => ({ type: 'text', text: String(vars[k]).trim() })
  return {
    ok: true,
    message: {
      to, templateName: t.metaName, languageCode: t.language,
      ...(t.headerOrder.length ? { headerParameters: t.headerOrder.map(param) } : {}),
      ...(t.bodyOrder.length ? { bodyParameters: t.bodyOrder.map(param) } : {}),
    },
  }
}
