'use client'

// Shared Business Configuration provider (RD-CONF-09.2). Fetches ALL public config
// ONCE from GET /api/config/public and exposes it via React context, so a page with
// many config consumers performs a single HTTP request instead of one per hook.
//
// Each domain hook (useLicenseCatalog / useCommunicationConfig / useWalletConfig /
// useSettlementConfig / useFeatureFlags) now just reads this context — same
// signatures, no direct fetches. Used outside the provider, they fall back to the
// code defaults (identical to pre-migration), so no caller has to change.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BUSINESS_CONFIG_DEFAULTS,
  type CommunicationConfig,
  type WalletConfig,
  type SettlementsConfig,
  type FeatureFlagsConfig,
  type BrandingConfig,
  type SecurityConfig,
  type IntegrationsConfig,
} from '@/lib/config/businessConfig'
import { defaultLicenseCatalog, reviveCatalog, type LicenseCatalog } from '@/lib/licensing/licenseCatalogShared'
import { defaultPublicFeesConfig, type PublicFeesConfig } from '@/lib/fees/publicFeesShared'

export interface BusinessConfigValue {
  licenseCatalog: LicenseCatalog
  communication:  CommunicationConfig
  wallet:         WalletConfig
  settlements:    SettlementsConfig
  featureFlags:   FeatureFlagsConfig
  branding:       BrandingConfig
  security:       SecurityConfig
  integrations:   IntegrationsConfig
  fees:           PublicFeesConfig
  loading:        boolean
  refresh:        () => void
}

// Code-default snapshot — computed once with a stable identity, so a hook used
// outside the provider doesn't return a new object every render.
const CODE_DEFAULTS = {
  licenseCatalog: defaultLicenseCatalog(),
  communication:  BUSINESS_CONFIG_DEFAULTS.communication,
  wallet:         BUSINESS_CONFIG_DEFAULTS.wallet,
  settlements:    BUSINESS_CONFIG_DEFAULTS.settlements,
  featureFlags:   BUSINESS_CONFIG_DEFAULTS.featureFlags,
  branding:       BUSINESS_CONFIG_DEFAULTS.branding,
  security:       BUSINESS_CONFIG_DEFAULTS.security,
  integrations:   BUSINESS_CONFIG_DEFAULTS.integrations,
  fees:           defaultPublicFeesConfig(),
}

interface RawPublicConfig {
  licenseCatalog?: unknown
  communication?:  CommunicationConfig
  wallet?:         WalletConfig
  settlements?:    SettlementsConfig
  featureFlags?:   FeatureFlagsConfig
  branding?:       BrandingConfig
  security?:       SecurityConfig
  integrations?:   IntegrationsConfig
  fees?:           PublicFeesConfig
}

type BusinessConfigData = typeof CODE_DEFAULTS

// Single public-config fetch. Always resolves to a full snapshot — on any failure
// it returns the code defaults (identical to pre-migration behaviour). Kept
// module-level, like fetchNotifications, so the hook's effect just awaits a plain
// async helper and applies the result.
async function fetchPublicConfig(): Promise<BusinessConfigData> {
  try {
    const res = await fetch('/api/config/public', { cache: 'no-store' })
    if (!res.ok) return CODE_DEFAULTS
    const body = await res.json() as { config?: RawPublicConfig }
    const c = body.config
    if (!c) return CODE_DEFAULTS
    return {
      licenseCatalog: reviveCatalog(c.licenseCatalog),
      communication:  c.communication ?? CODE_DEFAULTS.communication,
      wallet:         c.wallet        ?? CODE_DEFAULTS.wallet,
      settlements:    c.settlements   ?? CODE_DEFAULTS.settlements,
      featureFlags:   c.featureFlags  ?? CODE_DEFAULTS.featureFlags,
      branding:       c.branding      ?? CODE_DEFAULTS.branding,
      security:       c.security      ?? CODE_DEFAULTS.security,
      integrations:   c.integrations  ?? CODE_DEFAULTS.integrations,
      fees:           c.fees          ?? CODE_DEFAULTS.fees,
    }
  } catch {
    return CODE_DEFAULTS
  }
}

const BusinessConfigContext = createContext<BusinessConfigValue | null>(null)

export function BusinessConfigProvider({ children }: { children: ReactNode }) {
  const [data,    setData]    = useState<BusinessConfigData>(() => CODE_DEFAULTS)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    const next = await fetchPublicConfig()
    if (!mounted.current) return
    setData(next)
    setLoading(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  const value: BusinessConfigValue = { ...data, loading, refresh: () => { void load() } }
  return <BusinessConfigContext.Provider value={value}>{children}</BusinessConfigContext.Provider>
}

// Stable fallback for hooks used outside the provider (code defaults, no live fetch).
const FALLBACK_VALUE: BusinessConfigValue = { ...CODE_DEFAULTS, loading: false, refresh: () => {} }

/** Internal accessor consumed by the domain hooks. Falls back to code defaults when
 *  no provider is mounted, so any caller keeps working unchanged. */
export function useBusinessConfig(): BusinessConfigValue {
  return useContext(BusinessConfigContext) ?? FALLBACK_VALUE
}
