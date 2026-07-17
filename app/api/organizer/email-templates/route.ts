// GET  /api/organizer/email-templates          — load all 5 templates (custom or default)
// PUT  /api/organizer/email-templates          — save a single template

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { TEMPLATE_KEYS }             from '@/lib/email-templates/types'
import { getDefaultTemplate }        from '@/lib/email-templates/defaults'
import type { TemplateKey, EmailTemplateRecord } from '@/lib/email-templates/types'

type GetResponse = { success: true;  templates: Record<TemplateKey, EmailTemplateRecord> }
               | { success: false; error: string }
type PutResponse = { success: true }
               | { success: false; error: string }

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function getUid(req: NextRequest): Promise<string | null> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  return authz.ok ? authz.workspaceUid : null
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse<GetResponse>> {
  const uid = await getUid(req)
  if (!uid) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const collRef = adminDb.collection('users').doc(uid).collection('emailTemplates')
  const snap    = await collRef.get()

  const customMap = new Map<string, FirebaseFirestore.DocumentData>()
  snap.forEach(doc => customMap.set(doc.id, doc.data()))

  const templates = {} as Record<TemplateKey, EmailTemplateRecord>
  for (const key of TEMPLATE_KEYS) {
    const custom = customMap.get(key)
    const def    = getDefaultTemplate(key)
    if (custom) {
      templates[key] = {
        key,
        subject:      typeof custom.subject === 'string' ? custom.subject : def.subject,
        body:         typeof custom.body    === 'string' ? custom.body    : def.body,
        isCustomized: true,
        updatedAt:    custom.updatedAt?.toDate?.().toISOString() ?? null,
      }
    } else {
      templates[key] = { ...def, isCustomized: false, updatedAt: null }
    }
  }

  return NextResponse.json({ success: true, templates })
}

// ─── PUT ──────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest): Promise<NextResponse<PutResponse>> {
  const uid = await getUid(req)
  if (!uid) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }

  const { key, subject, bodyHtml } = body as Record<string, unknown>

  if (!TEMPLATE_KEYS.includes(key as TemplateKey)) {
    return NextResponse.json({ success: false, error: 'Invalid template key' }, { status: 400 })
  }
  if (typeof subject !== 'string' || subject.trim() === '') {
    return NextResponse.json({ success: false, error: 'subject is required' }, { status: 400 })
  }
  if (typeof bodyHtml !== 'string' || bodyHtml.trim() === '') {
    return NextResponse.json({ success: false, error: 'body is required' }, { status: 400 })
  }

  const docRef = adminDb.collection('users').doc(uid).collection('emailTemplates').doc(key as string)
  await docRef.set({
    key,
    subject:   subject.trim(),
    body:      bodyHtml.trim(),
    updatedAt: new Date(),
  }, { merge: false })

  return NextResponse.json({ success: true })
}
