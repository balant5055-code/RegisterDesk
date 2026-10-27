// RD-EMAIL-PROVIDER-04 — the PLATFORM email provider (Super Admin only).
//   GET → the selected provider, each provider's configuration status (presence and sender identity
//         only — never a key or secret), and how many events carry an explicit per-event override.
//   PUT { provider: 'ses' | 'resend', reason } → select it for ALL platform email.
//
// requireSuperAdmin (ADMIN_UIDS): a claim-only admin is refused. A provider whose credentials are
// absent is refused before anything is written (emailProviderSelectionRefusal). The change goes
// through businessConfig.updateSection — versioned, with its configuration-audit row — and an admin
// audit row is staged IN that same transaction. Nothing ever switches provider automatically.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { stageAdminAudit } from '@/lib/admin/audit'
import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import { parseEmailProviderName, type EmailProviderName } from '@/lib/email/providerName'
import { resolvePlatformEmailProvider, notePlatformEmailProvider } from '@/lib/email/platformProvider'
import { emailProviderSelectionRefusal, emailProviderStatuses, EMAIL_PROVIDER_LABEL } from '@/lib/email/providerSelection'

const NO_STORE = { 'Cache-Control': 'no-store' }

async function overrideCounts(): Promise<Record<EmailProviderName, number | null>> {
  const count = (v: EmailProviderName) => adminDb.collection('events').where('emailProvider', '==', v).count().get()
    .then(s => s.data().count).catch(() => null)
  const [ses, resend] = await Promise.all([count('ses'), count('resend')])
  return { ses, resend }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const [selected, eventOverrides] = await Promise.all([resolvePlatformEmailProvider(), overrideCounts()])
  const providers = await emailProviderStatuses()
  const active = providers.find(p => p.name === selected)!
  return NextResponse.json({
    selected,
    // The selected provider cannot send: mail is NOT being delivered (never silently rerouted).
    selectedUnavailable: !active.configured,
    providers,
    eventOverrides,
  }, { headers: NO_STORE })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  let body: { provider?: unknown; reason?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE }) }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: 'Give a reason for the change (5–500 characters).', code: 'REASON_REQUIRED' }, { status: 400, headers: NO_STORE })
  }
  const refusal = await emailProviderSelectionRefusal(body.provider)
  if (refusal) {
    return NextResponse.json({ error: refusal, code: body.provider === 'ses' || body.provider === 'resend' ? 'PROVIDER_NOT_CONFIGURED' : 'INVALID' }, { status: body.provider === 'ses' || body.provider === 'resend' ? 409 : 400, headers: NO_STORE })
  }
  const next = body.provider as EmailProviderName
  const current = await resolvePlatformEmailProvider()
  if (current === next) {
    return NextResponse.json({ error: `${EMAIL_PROVIDER_LABEL[next]} is already the platform email provider.`, code: 'NO_CHANGE' }, { status: 400, headers: NO_STORE })
  }
  try {
    const result = await businessConfig.updateSection('integrations', { emailProvider: next }, {
      updatedBy: gate.uid, reason, canEditPricing: false,
      stageInTransaction: (txn, info) => {
        const before = parseEmailProviderName((info.before as { emailProvider?: unknown } | null)?.emailProvider)
        stageAdminAudit(txn, {
          adminUid: gate.uid, actorRole: 'super_admin', action: 'platform.email_provider_changed', entityType: 'platform_settings',
          entityId: 'integrations.emailProvider', reason,
          changedFields: ['emailProvider'], before: { emailProvider: before }, after: { emailProvider: next },
          metadata: { configVersion: info.version },
        })
      },
    })
    notePlatformEmailProvider(next)
    return NextResponse.json({ ok: true, selected: next, version: result.version }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/email-provider] update failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save the change. Nothing was changed.' }, { status: 500, headers: NO_STORE })
  }
}
