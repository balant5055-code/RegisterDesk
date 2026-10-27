// GET/POST /api/admin/business-config
//
// Admin-only read + publish for the Business Configuration Engine. Every read and
// write goes through the BusinessConfigurationService — no config value is computed
// here. GET returns the resolved config + version + history; POST publishes a
// single section (validated + audited + versioned by the service).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { emailProviderSelectionRefusal } from '@/lib/email/providerSelection'
import { resolveGlobalCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'
import { getServiceCatalog } from '@/lib/licensing/serviceAllowanceConfig'
import { serviceSaleReadinessErrors, SERVICE_KINDS, type ServiceKind, type ServiceSaleState } from '@/lib/licensing/serviceAllowances'
import { FieldValue } from 'firebase-admin/firestore'
import { parseFinancialReason } from '@/lib/admin/financialGuard'
import type { AdminAuditLog } from '@/lib/admin/auditConstants'
import {
  badgeSettingsOf, badgeSettingsChanged, badgeSettingsProblems, BadgeSettingsError, describeBadgeSettingsIssue,
} from '@/lib/licensing/printBadgeSettings'
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

  // RD-EMAIL-PROVIDER-04 — the platform email provider: the same refusal the Communication Center
  // applies. A provider without credentials can never become the platform provider (no fallback).
  if (body.section === 'integrations' && (body.patch as { emailProvider?: unknown }).emailProvider !== undefined) {
    if (!isSuperAdmin) return NextResponse.json({ error: 'Only a Super Admin can change the email provider.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403, headers: NO_STORE })
    const refusal = await emailProviderSelectionRefusal((body.patch as { emailProvider?: unknown }).emailProvider)
    if (refusal) return NextResponse.json({ error: refusal, code: 'PROVIDER_NOT_CONFIGURED' }, { status: 409, headers: NO_STORE })
  }
  // RD-WA-TEMPLATES-01 — the WhatsApp template review mode has ONE writer: the Super Admin
  // WhatsApp Templates page (reason required, its own audit action). Never edited from here. The
  // editor sends the whole section, so an UNCHANGED value passes; only a change is refused.
  const patchedReviewMode = body.section === 'integrations' ? (body.patch as { whatsappTemplateReviewMode?: unknown }).whatsappTemplateReviewMode : undefined
  if (patchedReviewMode !== undefined && patchedReviewMode !== (await businessConfig.getSection('integrations') as { whatsappTemplateReviewMode?: unknown }).whatsappTemplateReviewMode) {
    return NextResponse.json({ error: 'Change the WhatsApp template review mode from Admin → WhatsApp Templates.', code: 'USE_TEMPLATE_GOVERNANCE' }, { status: 403, headers: NO_STORE })
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
    // RD-PRINT-BILL-P2 — readiness is judged for the SELLABLE services only. A catalog-only
    // service (print_badges) is judged in the save transaction below, and only when this save
    // CHANGES it — so an incomplete stored one can never block an unrelated licensing edit.
    const readiness = serviceSaleReadinessErrors(Object.fromEntries(
      Object.entries(candidate.serviceAllowances).filter(([k]) => (SERVICE_KINDS as readonly string[]).includes(k))))
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
      {
        updatedBy: adminUid, reason, canEditPricing: isSuperAdmin,
        ...(body.section === 'licensing' ? { stageInTransaction: badgeSettingsGuard(adminUid, body.reason) } : {}),
      },
    )
    return NextResponse.json({ ok: true, version: result.version, section: result.section }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof BadgeSettingsError) {
      // Nothing was written: the save transaction aborted before commit.
      const status = e.code === 'BADGE_SETTINGS_LOCKED' ? 409 : 400
      return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status, headers: NO_STORE })
    }
    if (e instanceof CentralPricingPermissionError) {
      // Nothing was written: the transaction threw before any write.
      return NextResponse.json({ error: e.message, code: 'SUPER_ADMIN_REQUIRED', fields: e.fields }, { status: 403, headers: NO_STORE })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Update failed' }, { status: 400, headers: NO_STORE })
  }
}

/**
 * RD-PRINT-BILL-P2 — the badge-settings rules, run INSIDE the licensing save transaction against
 * the fresh stored state (`before`) and exactly what will be stored (`after`). Only a save that
 * CHANGES the badge settings is affected: it must carry a 3–500 character reason, keep the
 * for-sale switch and paid generation locked off, and be valid; it then stages ONE extra admin
 * audit row (deterministic id per config version) in the same commit. Throwing aborts the whole
 * save — nothing is written. Unrelated licensing saves are untouched (their existing audit stands).
 */
function badgeSettingsGuard(adminUid: string, rawReason: unknown) {
  return (txn: FirebaseFirestore.Transaction, info: { version: number; before: unknown; after: unknown; db: FirebaseFirestore.Firestore }): void => {
    const before = badgeSettingsOf(info.before)
    const after  = badgeSettingsOf(info.after)
    if (!badgeSettingsChanged(before, after)) return
    const reason = parseFinancialReason(rawReason)
    if (!reason.ok) throw new BadgeSettingsError(reason.code, `Badge settings: ${reason.error}`)
    const problems = badgeSettingsProblems(after)
    // RD-PRINT-BILL-P2.1 — administrator wording (the raw configuration paths stay out of the banner).
    const words = (list: string[]) => list.map(m => describeBadgeSettingsIssue(m).message)
    if (problems.locked.length > 0) throw new BadgeSettingsError('BADGE_SETTINGS_LOCKED', `Not published — ID badges: ${words(problems.locked).join(' ')}`, words(problems.locked))
    if (problems.errors.length > 0) throw new BadgeSettingsError('BADGE_SETTINGS_INVALID', `Not published — ID badges: ${words(problems.errors).join(' ')}`, words(problems.errors))
    const audit: AdminAuditLog = {
      adminUid,
      action:     'print_badge_settings.updated',
      entityType: 'platform_settings',
      entityId:   'licensing.print_badges',
      metadata: {
        reason: reason.reason, configVersion: info.version,
        before: { printBadges: before.printBadges ?? null, printBadgeBilling: before.printBadgeBilling ?? null, printBadgePilot: before.printBadgePilot ?? null },
        after:  { printBadges: after.printBadges ?? null,  printBadgeBilling: after.printBadgeBilling ?? null,  printBadgePilot: after.printBadgePilot ?? null },
      },
      createdAt: FieldValue.serverTimestamp(),
    }
    // The service's own database handle — this route keeps no direct Firestore import.
    txn.set(info.db.collection('adminAuditLogs').doc(`badge_settings_v${info.version}`), audit)
  }
}
