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

// RD-ENV-ARCH-03 — the Meta partial-config validation lives HERE (the WhatsApp
// subsystem boundary) rather than in the shared lib/env.ts, so partially-set META_*
// vars fail only when the WhatsApp module loads — never unrelated routes. Setting ANY
// core var opts in and requires the full set; we fail fast with the specific missing
// variables rather than erroring on first use. Skipped during `next build`.
const _metaRequired: Record<string, string> = {
  META_APP_ID,
  META_APP_SECRET,
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_BUSINESS_ACCOUNT_ID,
  META_WEBHOOK_VERIFY_TOKEN,
}
if (process.env.NEXT_PHASE !== 'phase-production-build' && Object.values(_metaRequired).some(Boolean)) {
  const missing = Object.entries(_metaRequired).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    throw new Error(
      `[env] WhatsApp (Meta Cloud API) is partially configured. Missing: ${missing.join(', ')}.\n` +
      '  Once any META_* variable is set, all of META_APP_ID, META_APP_SECRET, ' +
      'META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID and ' +
      'META_WEBHOOK_VERIFY_TOKEN are required.\n' +
      '  Hint: Meta App Dashboard → WhatsApp → API Setup. Leave all unset to disable WhatsApp.',
    )
  }
}

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
