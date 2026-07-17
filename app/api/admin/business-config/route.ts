// GET/POST /api/admin/business-config
//
// Admin-only read + publish for the Business Configuration Engine. Every read and
// write goes through the BusinessConfigurationService — no config value is computed
// here. GET returns the resolved config + version + history; POST publishes a
// single section (validated + audited + versioned by the service).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { businessConfig } from '@/lib/config/businessConfigService'
import {
  CONFIG_SECTION_KEYS,
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

export interface BusinessConfigResponse {
  version: number
  config:  BusinessConfigSections
  history: ConfigHistoryEntry[]
  meta:    { updatedBy: string | null; updatedAt: string | null; reason: string | null }
}

function isSectionKey(v: unknown): v is BusinessConfigSectionKey {
  return typeof v === 'string' && (CONFIG_SECTION_KEYS as string[]).includes(v)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE })

  const [version, config, historyRaw] = await Promise.all([
    businessConfig.getVersion(),
    businessConfig.getConfig(),
    businessConfig.listHistory(50),
  ])

  const history: ConfigHistoryEntry[] = historyRaw.map(h => ({
    version:   typeof h.version === 'number' ? h.version : 0,
    section:   typeof h.section === 'string' ? h.section : '',
    updatedBy: typeof h.updatedBy === 'string' ? h.updatedBy : '',
    reason:    typeof h.reason === 'string' ? h.reason : '',
    updatedAt: tsToISO(h.createdAt),
  }))
  const latest = history[0]
  const body: BusinessConfigResponse = {
    version, config, history,
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
  if (typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
    return NextResponse.json({ error: 'patch must be an object' }, { status: 400, headers: NO_STORE })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return NextResponse.json({ error: 'A reason is required to publish' }, { status: 400, headers: NO_STORE })

  try {
    // The service (updateSection) re-validates `patch` against the section schema and
    // rejects invalid values, so the unvalidated JSON body is safe here; the cast only
    // bridges the generic key — patch is typed against the resolved section union.
    const result = await businessConfig.updateSection(
      body.section,
      body.patch as Partial<BusinessConfigSections[BusinessConfigSectionKey]>,
      { updatedBy: adminUid, reason },
    )
    return NextResponse.json({ ok: true, version: result.version, section: result.section }, { headers: NO_STORE })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Update failed' }, { status: 400, headers: NO_STORE })
  }
}
