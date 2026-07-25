// GET /admin/communications/campaign-composer — the canonical Campaign Composer (admin-only,
// READ-ONLY). Assembles an ephemeral CampaignDraft by composing the canonical resolvers.
// Persists nothing, executes nothing, schedules nothing, sends nothing.
// RD-PLATFORM-COMMS-02 Phase 5C.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveCampaignDraft } from '@/lib/communications/composer/resolve'
import type { ComposerInput } from '@/lib/communications/composer/types'
import type { TemplateChannel } from '@/lib/communications/templates/registry'
import type { CampaignType, CampaignCategory } from '@/lib/communications/campaigns/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const notificationId = q.get('notificationId') ?? ''
    if (!notificationId) return NextResponse.json({ error: 'notificationId is required' }, { status: 400 })
    const input: ComposerInput = {
      notificationId,
      channel:    (q.get('channel') as TemplateChannel | null) ?? 'email',
      audienceId: q.get('audienceId') ?? undefined,
      name:       q.get('name') ?? undefined,
      type:       (q.get('type')     as CampaignType     | null) ?? undefined,
      category:   (q.get('category') as CampaignCategory | null) ?? undefined,
    }
    const data = await resolveCampaignDraft(input, adminUid)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/campaign-composer] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
