// Meta Cloud API (WhatsApp) provider — server-only.
//
// Implements real template sending via the Cloud API (no SDK). The provider is
// DISCOVERABLE by the Notification Engine's resolver, but this phase does NOT
// route any notification to it — sending is exercised only directly (health
// check / developer test). It never leaks Graph API/SDK details: callers receive
// typed metadata and normalized results, never raw Meta payloads.

import { MetaGraphClient } from './client'
import { buildTemplatePayload } from './payload'
import type { MetaConfig } from './config'
import type { WhatsAppTemplateMessage, WhatsAppSendResult } from './types'

export interface MetaHealthResult {
  ok:                  boolean
  configured:          boolean
  apiVersion:          string
  token:               'valid' | 'invalid' | 'unknown'
  tokenType?:          'system_user' | 'user' | 'page' | 'unknown'
  tokenIsPermanent?:   boolean       // false ⇒ temporary token — not production-safe
  tokenExpiresAt?:     number        // unix seconds; 0 = never
  businessAccountId:   string | null
  businessAccountName?: string
  phoneNumberId:       string | null
  displayPhoneNumber?: string
  verifiedName?:       string
  qualityRating?:      string
  messagingCapable:    boolean
  error?:              string   // normalized message only
}

// Public marker interface the resolver hands out. Sending is behind sendTemplate();
// sendTestMessage() is a dev-only convenience. Business code reaches none of this
// in Phase G3.2 — no notification type targets WhatsApp.
export interface WhatsAppProvider {
  readonly channel:           'whatsapp'
  readonly phoneNumberId:     string
  readonly businessAccountId: string
  readonly apiVersion:        string
  healthCheck(): Promise<MetaHealthResult>
  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>
  sendTestMessage(to: string, templateName?: string, languageCode?: string): Promise<WhatsAppSendResult>
}

interface PhoneNumberNode {
  id:                        string
  display_phone_number?:     string
  verified_name?:            string
  quality_rating?:           string
  code_verification_status?: string
  platform_type?:            string
}

interface WabaNode {
  id:    string
  name?: string
}

interface MessagesResponse {
  messaging_product?: string
  contacts?: Array<{ input: string; wa_id: string }>
  messages?: Array<{ id: string; message_status?: string }>
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly channel = 'whatsapp' as const
  readonly phoneNumberId:     string
  readonly businessAccountId: string
  readonly apiVersion:        string
  private readonly client: MetaGraphClient

  constructor(config: MetaConfig) {
    this.phoneNumberId     = config.phoneNumberId
    this.businessAccountId = config.businessAccountId
    this.apiVersion        = config.apiVersion
    this.client            = new MetaGraphClient(config)
  }

  /**
   * Verify configuration + token + phone number + business account + messaging
   * capability + API version, LIVE, via Graph reads. Sends NO message. All
   * failures surface as a normalized error string — the raw Graph payload is
   * never exposed.
   */
  async healthCheck(): Promise<MetaHealthResult> {
    const base: MetaHealthResult = {
      ok:                false,
      configured:        true,
      apiVersion:        this.apiVersion,
      token:             'unknown',
      businessAccountId: this.businessAccountId,
      phoneNumberId:     this.phoneNumberId,
      messagingCapable:  false,
    }

    const phone = await this.client.get<PhoneNumberNode>(this.phoneNumberId, {
      fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type',
    })
    if (!phone.ok) {
      // 190 = invalid/expired token; anything else = token unknown but request failed.
      return { ...base, token: phone.error.code === 190 ? 'invalid' : 'unknown', error: phone.error.message }
    }

    // Business account read confirms WABA access (independent of the phone node).
    const waba = await this.client.get<WabaNode>(this.businessAccountId, { fields: 'id,name' })

    // PART 7: classify the access token (system-user vs temporary). Never logs the token.
    const tokenInfo = await this.client.getTokenInfo()
    if (tokenInfo && !tokenInfo.isPermanent) {
      const when = tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt * 1000).toISOString() : 'soon'
      console.warn(`[whatsapp] ⚠ TEMPORARY Meta access token (type=${tokenInfo.tokenType}, expires ${when}). Use a System User token for production.`)
    } else if (tokenInfo) {
      console.info(`[whatsapp] Meta access token OK · type=${tokenInfo.tokenType} · permanent=${tokenInfo.isPermanent}`)
    }

    const verified = phone.data.code_verification_status === 'VERIFIED'
    return {
      ...base,
      ok:                  true,
      token:               'valid',
      tokenType:           tokenInfo?.tokenType,
      tokenIsPermanent:    tokenInfo?.isPermanent,
      tokenExpiresAt:      tokenInfo?.expiresAt,
      businessAccountName: waba.ok ? waba.data.name : undefined,
      displayPhoneNumber:  phone.data.display_phone_number,
      verifiedName:        phone.data.verified_name,
      qualityRating:       phone.data.quality_rating,
      // "Messaging capable" = we can read the phone node and it is verified for use.
      messagingCapable:    verified || Boolean(phone.data.platform_type),
    }
  }

  /**
   * Send a pre-approved WhatsApp template message via POST /{PHONE_NUMBER_ID}/messages.
   * Returns a normalized result with the Meta message id — never a raw payload.
   */
  async sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    const body = buildTemplatePayload(message)
    const res  = await this.client.post<MessagesResponse>(`${this.phoneNumberId}/messages`, body)

    if (!res.ok) {
      return {
        success:         false,
        error:           res.error.message,
        code:            res.error.code,
        httpStatus:      res.error.httpStatus,
        providerMessage: res.error.providerMessage,
        retriable:       res.error.retriable,
      }
    }
    const msg = res.data.messages?.[0]
    return { success: true, messageId: msg?.id, status: msg?.message_status ?? 'accepted' }
  }

  /**
   * DEVELOPMENT-ONLY provider smoke test (STEP 7). Sends Meta's default
   * "hello_world" template (no parameters) to a verified test number so the
   * provider can be validated end-to-end. Bypasses the Notification Engine and
   * all business logic — do not use for product notifications.
   */
  async sendTestMessage(
    to: string,
    templateName  = 'hello_world',
    languageCode  = 'en_US',
  ): Promise<WhatsAppSendResult> {
    return this.sendTemplate({ to, templateName, languageCode })
  }
}
