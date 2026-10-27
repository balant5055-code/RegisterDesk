// RD-SUPPORT-01 — Super Admin Support Desk: the ticket queue.
//   GET ?status=&priority=&category=&assignee=(me|unassigned|<uid>)&q=
//     → rows (bounded), per-status counts, and the assignable Super Admins.
// requireSuperAdmin (ADMIN_UIDS): a claim-only admin is refused.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { isTicketStatus, TICKET_PRIORITIES, TICKET_CATEGORIES } from '@/lib/support/types'
import { adminListTickets, superAdminDirectory } from '@/lib/support/service'
import { supportErrorResponse, ID_RE, NO_STORE } from '@/lib/support/http'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const sp = new URL(req.url).searchParams
  const status = sp.get('status')
  const priority = sp.get('priority')
  const category = sp.get('category')
  const assignee = sp.get('assignee')
  try {
    const [list, admins] = await Promise.all([
      adminListTickets({
        status: isTicketStatus(status) ? status : null,
        priority: priority && (TICKET_PRIORITIES as readonly string[]).includes(priority) ? priority : null,
        category: category && (TICKET_CATEGORIES as readonly string[]).includes(category) ? category : null,
        assignee: assignee && (assignee === 'me' || assignee === 'unassigned' || ID_RE.test(assignee)) ? assignee : null,
        q: (sp.get('q') ?? '').slice(0, 100), adminUid: gate.uid,
      }),
      superAdminDirectory(),
    ])
    return NextResponse.json({ ...list, admins, me: gate.uid }, { headers: NO_STORE })
  } catch (err) { return supportErrorResponse(err, 'admin list') }
}
