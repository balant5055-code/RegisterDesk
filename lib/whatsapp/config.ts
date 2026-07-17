// Meta Cloud API (WhatsApp) configuration — server-only.
//
// Foundation phase (G3.1): this module resolves and shapes the Meta configuration.
// It performs no network calls and sends nothing. Env presence/validation lives in
// lib/env.ts (fail-fast at startup); here we only assemble a typed config object.

import {
  META_APP_ID,
  META_APP_SECRET,
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_BUSINESS_ACCOUNT_ID,
  META_WEBHOOK_VERIFY_TOKEN,
} from '@/lib/env'
import { getIntegrationConfig } from '@/lib/config/resolveIntegrationConfig'

export interface MetaConfig {
  appId:              string
  appSecret:          string
  accessToken:        string
  phoneNumberId:      string
  businessAccountId:  string
  webhookVerifyToken: string
  apiVersion:         string   // e.g. "v21.0" — from integrations policy (RD-CONF-12)
  apiTimeoutMs:       number   // Meta Graph API request timeout — from integrations policy
}

/** True when the core Meta credentials required to talk to the Graph API are present.
 *  SECRETS ONLY (env) — this stays SYNC so notification-availability checks don't. */
export function isMetaConfigured(): boolean {
  return Boolean(
    META_APP_ID &&
    META_APP_SECRET &&
    META_ACCESS_TOKEN &&
    META_PHONE_NUMBER_ID &&
    META_BUSINESS_ACCOUNT_ID,
  )
}

/** Assembled config, or null when WhatsApp is disabled (unset). Secrets come from
 *  env; the API version + timeout are non-secret OPERATIONAL POLICY resolved from
 *  the Business Configuration `integrations` section (RD-CONF-12). */
export async function getMetaConfig(): Promise<MetaConfig | null> {
  if (!isMetaConfigured()) return null
  const integrations = await getIntegrationConfig()
  return {
    appId:              META_APP_ID,
    appSecret:          META_APP_SECRET,
    accessToken:        META_ACCESS_TOKEN,
    phoneNumberId:      META_PHONE_NUMBER_ID,
    businessAccountId:  META_BUSINESS_ACCOUNT_ID,
    webhookVerifyToken: META_WEBHOOK_VERIFY_TOKEN,
    apiVersion:         integrations.metaApiVersion,
    apiTimeoutMs:       integrations.metaApiTimeoutMs,
  }
}

/** The token Meta echoes during the webhook verification handshake (STEP 5). */
export function getWebhookVerifyToken(): string {
  return META_WEBHOOK_VERIFY_TOKEN
}
