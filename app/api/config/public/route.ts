// GET /api/config/public — the SINGLE public-config endpoint (RD-CONF-09.2).
//
// Returns every client-facing configuration section in one payload so the shared
// BusinessConfigProvider fetches once. All five resolvers read the same 60s-cached
// config doc, so this is effectively one Firestore read.
//
// Public (non-secret) values ONLY: license catalog (prices/limits/features),
// communication policy, wallet limits, settlement policy, feature flags, branding,
// security POLICY (OTP length/expiry/attempts, session timeouts — no secrets). It
// exposes NO secrets/tokens/keys/credentials and NO internal metadata
// (version/audit/history).

import { NextResponse } from 'next/server'
import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import { getSettlementConfig } from '@/lib/settlements/resolveSettlementConfig'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { getSecurityConfig } from '@/lib/config/resolveSecurityConfig'
import { getIntegrationConfig } from '@/lib/config/resolveIntegrationConfig'
import { getPublicFeesConfig } from '@/lib/fees/resolvePublicFeesConfig'

export async function GET(): Promise<NextResponse> {
  const [licenseCatalog, communication, wallet, settlements, featureFlags, branding, security, integrations, fees] = await Promise.all([
    getLicenseCatalog(),
    getCommunicationConfig(),
    getWalletConfig(),
    getSettlementConfig(),
    getFeatureFlags(),
    getBrandingConfig(),
    getSecurityConfig(),
    getIntegrationConfig(),
    getPublicFeesConfig(),
  ])
  // Infinity license limits serialize to null via JSON; the client revives them.
  return NextResponse.json(
    { config: { licenseCatalog, communication, wallet, settlements, featureFlags, branding, security, integrations, fees } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
