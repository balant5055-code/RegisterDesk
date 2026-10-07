// GET/POST /api/admin/business-config
//
// Admin-only read + publish for the Business Configuration Engine. Every read and
// write goes through the BusinessConfigurationService — no config value is computed
// here. GET returns the resolved config + version + history; POST publishes a
// single section (validated + audited + versioned by the service).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { resolveGlobalCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'
import { getServiceCatalog } from '@/lib/licensing/serviceAllowanceConfig'
import { serviceSaleReadinessErrors, type ServiceKind, type ServiceSaleState } from '@/lib/licensing/serviceAllowances'
import {
  isCashfreeEnabled, isCashfreeSandboxEnabled, isCashfreeProductionEnabled,
} from '@/lib/payments/providers'
import { cashfreeEnvironment } from '@/lib/payments/providers/cashfreeAdapter'
import { activeProviderSelectionRefusal } from '@/lib/payments/providerSelection'
import { businessConfig } from '@/lib/config/businessConfigService'
import {
  CONFIG_SECTION_KEYS,
  CentralPricingPermissionError,
  redactSuperAdminOnlyFields,
  type BusinessConfigSections,
  type BusinessConfigSectionKey,
} from '@/lib/config/businessConfig'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

function tsToISO(v: unknown): string | null {
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().toISOString()
  return typeof v === 'string' ? v : null
}

export interface ConfigHistoryEntry {
  version:   number
  section:   string
  updatedBy: string
  reason:    string
  updatedAt: string | null
}

/**
 * What the admin UI may know about gateway readiness.
 *
 * BOOLEANS AND AN ENVIRONMENT NAME ONLY. Credentials, secrets and raw environment values
 * never cross to the client — the questions the UI needs answered are "may I select this?"
 * and "why not?", and neither requires knowing a key.
 *
 * It is advisory for RENDERING. The server re-decides on every order and every write, so a
 * client that ignored this could still not select an impermissible gateway.
 */
export interface GatewayReadiness {
  /** 'sandbox' | 'production' — which Cashfree deployment this process is pointed at. */
  cashfreeEnvironment: 'sandbox' | 'production'
  /** Cashfree may be selected right now (sandbox gates satisfied). */
  cashfreeSandboxReady: boolean
  /** Cashfree PRODUCTION is activated and configured. False until separately authorized. */
  cashfreeProductionReady: boolean
  /** Whichever of the two applies to this process — what the switch can actually grant. */
  cashfreeSelectable: boolean
  /** Razorpay is the incumbent and is always selectable. */
  razorpaySelectable: boolean
}

export interface ConfigurationAuditEntry {
  version:       number
  section:       string
  updatedBy:     string
  reason:        string
  at:            string | null
  changedFields: string[]
  /** Only the changed top-level fields, before and after. */
  before:        Record<string, unknown> | null
  after:         Record<string, unknown> | null
}

export interface BusinessConfigResponse {
  version: number
  config:  BusinessConfigSections
  history: ConfigHistoryEntry[]
  meta:    { updatedBy: string | null; updatedAt: string | null; reason: string | null }
  gateways: GatewayReadiness
  /**
   * RD-EVENT-COMMERCE-04A — what THIS caller may change, decided by the server from the verified
   * token (never from anything the browser sends). Advisory for rendering; POST re-decides.
   */
  permissions: { canEditPricing: boolean }
  /**
   * RD-PHASE4-S4 · F11 — the configurationAudit trail (before/after of each published change),
   * discoverable at last. Super Admin only (D7); absent for anyone else.
   */
  configurationAudit?: ConfigurationAuditEntry[]
  /**
   * RD-EVENT-COMMERCE-04A — integrity of the STORED capacity-pricing group. `config` shows the
   * resolved view (a corrupt group resolves to defaults there), so without this an admin could
   * not see that charging is currently refused.
   */
  commercialIntegrity: { ok: true } | { ok: false; reason: string; errors: string[] }
  /**
   * RD-EVENT-COMMERCE-05 — each prepaid service's LIVE sale state as organizers see it (resolved
   * per service from the stored doc): available / not_configured / disabled / invalid / unavailable.
   */
  serviceSaleStates: Record<ServiceKind, ServiceSaleState>
}

/**
 * RD-EVENT-COMMERCE-04A — sections that are pricing IN THEIR ENTIRETY (licence & capacity).
 * Writing them at all requires the Super Admin mechanism (`ADMIN_UIDS`), the same one that
 * guards refunds, refund retries and credit grants.
 *
 * RD-EVENT-COMMERCE-04B — sections that MIX pricing with operational settings (communication
 * rates incl. certificate pricing, media / extra-photo pricing) are gated per FIELD instead:
 * see CENTRAL_PRICING_FIELDS. That check runs inside the save transaction against the fresh
 * stored doc, so a stale cache cannot make a price change look like "no change".
 */
// RD-PHASE4-S2 — `fees` is wholly pricing too (it is also '*' in CENTRAL_PRICING_FIELDS, which the
// transaction enforces on fresh state; this is the early, cheap refusal).
const PRICING_SECTIONS: readonly BusinessConfigSectionKey[] = ['licensing', 'fees']

function isSectionKey(v: unknown): v is BusinessConfigSectionKey {
  return typeof v === 'string' && (CONFIG_SECTION_KEYS as string[]).includes(v)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE })

  const [version, config, historyRaw, superUid, commercial, services] = await Promise.all([
    businessConfig.getVersion(),
    businessConfig.getConfig(),
    businessConfig.listHistory(50),
    resolveSuperAdminUid(req.headers.get('authorization')),
    resolveGlobalCommercialTerms(),
    getServiceCatalog(),
  ])

  // RD-PHASE4-S4 · F11 + D7 — the configuration audit, for a Super Admin only.
  const configurationAudit: ConfigurationAuditEntry[] | undefined = superUid === null ? undefined
    : (await businessConfig.listAudit(50).catch(() => [])).map(a => {
        const before = a.before && typeof a.before === 'object' ? a.before as Record<string, unknown> : null
        const after  = a.after  && typeof a.after  === 'object' ? a.after  as Record<string, unknown> : null
        const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]))
          .filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
        return {
          version:       typeof a.version === 'number' ? a.version : 0,
          section:       typeof a.section === 'string' ? a.section : '',
          updatedBy:     typeof a.updatedBy === 'string' ? a.updatedBy : '',
          reason:        typeof a.reason === 'string' ? a.reason : '',
          at:            tsToISO(a.at),
          changedFields: keys,
          before:        before ? Object.fromEntries(keys.map(k => [k, before[k] ?? null])) : null,
          after:         after  ? Object.fromEntries(keys.map(k => [k, after[k]  ?? null])) : null,
        }
      })

  const history: ConfigHistoryEntry[] = historyRaw.map(h => ({
    version:   typeof h.version === 'number' ? h.version : 0,
    section:   typeof h.section === 'string' ? h.section : '',
    updatedBy: typeof h.updatedBy === 'string' ? h.updatedBy : '',
    reason:    typeof h.reason === 'string' ? h.reason : '',
    updatedAt: tsToISO(h.createdAt),
  }))
  const latest = history[0]
  // Readiness is computed from the SAME gates the order path uses, so the UI cannot show a
  // gateway as available that the server would then refuse.
  const gateways: GatewayReadiness = {
    cashfreeEnvironment:     cashfreeEnvironment(),
    cashfreeSandboxReady:    isCashfreeSandboxEnabled(),
    cashfreeProductionReady: isCashfreeProductionEnabled(),
    cashfreeSelectable:      isCashfreeEnabled(),
    razorpaySelectable:      true,
  }

  const body: BusinessConfigResponse = {
    // RD-WALLET-CFG-01 — the wallet's financial controls are Super Admin only to SEE as well as to
    // change: anyone else (a legacy `admin: true` caller) gets the config without them. Their saves
    // then carry no such field, so the transaction's per-field check sees no change to refuse.
    version, config: superUid === null ? redactSuperAdminOnlyFields(config) : config, history, gateways,
    permissions: { canEditPricing: superUid !== null },
    ...(configurationAudit ? { configurationAudit } : {}),
    commercialIntegrity: commercial.ok ? { ok: true } : { ok: false, reason: commercial.reason, errors: commercial.errors },
    serviceSaleStates: services.state,
    meta: { updatedBy: latest?.updatedBy ?? null, updatedAt: latest?.updatedAt ?? null, reason: latest?.reason ?? null },
  }
  return NextResponse.json(body, { headers: NO_STORE })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE })

  let body: { section?: unknown; patch?: unknown; reason?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }

  if (!isSectionKey(body.section)) return NextResponse.json({ error: 'Invalid section' }, { status: 400, headers: NO_STORE })
  // RD-EVENT-COMMERCE-04A/04B — decided ONCE from the verified token; body fields never count.
  const isSuperAdmin = (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null
  if (PRICING_SECTIONS.includes(body.section) && !isSuperAdmin) {
    return NextResponse.json({ error: 'Only a Super Admin can change commercial pricing.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403, headers: NO_STORE })
  }
  if (typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
    return NextResponse.json({ error: 'patch must be an object' }, { status: 400, headers: NO_STORE })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return NextResponse.json({ error: 'A reason is required to publish' }, { status: 400, headers: NO_STORE })

  // RD-PREPROD · selecting Cashfree while its production gate is shut would block every new
  // payment (no fallback by design) — refused before anything is written. Razorpay unaffected.
  if (body.section === 'payments') {
    const refusal = activeProviderSelectionRefusal((body.patch as { activeProvider?: unknown }).activeProvider, {
      productionEnabled: isCashfreeProductionEnabled(),
      sandboxEnabled:    isCashfreeSandboxEnabled(),
      emulator:          Boolean(process.env.FIRESTORE_EMULATOR_HOST),
    })
    if (refusal) return NextResponse.json({ error: refusal, code: 'CASHFREE_NOT_ENABLED' }, { status: 409, headers: NO_STORE })
  }

  // RD-EVENT-COMMERCE-05 — SAVE-TIME sale readiness for prepaid services: a service may not be
  // published "for sale" with a pricing decision missing, nor with presets outside its range.
  // (Kept out of the READ validator on purpose — see serviceSaleReadinessErrors.)
  if (body.section === 'licensing') {
    // Per-service SHALLOW spread, not deepMerge: deepMerge treats a patched `null` as "keep the
    // current value", so "for sale" + a cleared price would be judged against the OLD price and
    // pass — while Firestore stores the null. What is judged must be what will be stored.
    const current = (await businessConfig.getSection('licensing')).serviceAllowances as Record<string, Record<string, unknown>> | undefined
    const patched = ((body.patch as { serviceAllowances?: unknown }).serviceAllowances ?? {}) as Record<string, unknown>
    const candidate = { serviceAllowances: Object.fromEntries(Object.keys({ ...(current ?? {}), ...patched }).map(k => [k,
      typeof patched[k] === 'object' && patched[k] !== null && !Array.isArray(patched[k])
        ? { ...(current?.[k] ?? {}), ...(patched[k] as Record<string, unknown>) }
        : patched[k] ?? current?.[k]])) }
    const readiness = serviceSaleReadinessErrors(candidate.serviceAllowances)
    if (readiness.length > 0) {
      return NextResponse.json({ error: `Not published: ${readiness.join('; ')}`, code: 'SERVICE_NOT_READY', details: readiness }, { status: 400, headers: NO_STORE })
    }
  }

  try {
    // The service (updateSection) re-validates `patch` against the section schema and
    // rejects invalid values, so the unvalidated JSON body is safe here; the cast only
    // bridges the generic key — patch is typed against the resolved section union.
    const result = await businessConfig.updateSection(
      body.section,
      body.patch as Partial<BusinessConfigSections[BusinessConfigSectionKey]>,
      { updatedBy: adminUid, reason, canEditPricing: isSuperAdmin },
    )
    return NextResponse.json({ ok: true, version: result.version, section: result.section }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof CentralPricingPermissionError) {
      // Nothing was written: the transaction threw before any write.
      return NextResponse.json({ error: e.message, code: 'SUPER_ADMIN_REQUIRED', fields: e.fields }, { status: 403, headers: NO_STORE })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Update failed' }, { status: 400, headers: NO_STORE })
  }
}
