// Incident tracking (Phase G.6). Server-only. Admin-managed operational incidents
// stored in incidentReports. Pure operational tooling — touches no business state.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export type IncidentStatus   = 'open' | 'investigating' | 'resolved'
export type IncidentSeverity = 'critical' | 'major' | 'minor'

export const INCIDENTS = 'incidentReports'

export interface IncidentDoc {
  incidentId:  string
  title:       string
  description: string
  severity:    IncidentSeverity
  status:      IncidentStatus
  postmortem:  string
  createdBy:   string
  resolvedBy?: string
  createdAt:   unknown
  updatedAt:   unknown
  resolvedAt:  unknown | null
}

export interface IncidentView {
  incidentId:  string
  title:       string
  description: string
  severity:    IncidentSeverity
  status:      IncidentStatus
  postmortem:  string
  createdBy:   string
  resolvedBy:  string | null
  createdAt:   string | null
  updatedAt:   string | null
  resolvedAt:  string | null
}

const tsToISO = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

function toView(d: IncidentDoc): IncidentView {
  return {
    incidentId: d.incidentId, title: d.title, description: d.description,
    severity: d.severity, status: d.status, postmortem: d.postmortem ?? '',
    createdBy: d.createdBy, resolvedBy: d.resolvedBy ?? null,
    createdAt: tsToISO(d.createdAt), updatedAt: tsToISO(d.updatedAt), resolvedAt: tsToISO(d.resolvedAt),
  }
}

const SEVERITIES: IncidentSeverity[] = ['critical', 'major', 'minor']
const STATUSES:   IncidentStatus[]   = ['open', 'investigating', 'resolved']
export const isSeverity = (v: unknown): v is IncidentSeverity => SEVERITIES.includes(v as IncidentSeverity)
export const isStatus   = (v: unknown): v is IncidentStatus   => STATUSES.includes(v as IncidentStatus)

/** Most recent incidents (newest first), optionally filtered by status. The status
 *  filter is applied in memory (incidents are low-volume) so only the auto
 *  single-field createdAt index is needed — no composite index. */
export async function listIncidents(opts?: { status?: IncidentStatus; limit?: number }): Promise<IncidentView[]> {
  const limit = Math.min(opts?.limit ?? 100, 200)
  const snap = await adminDb.collection(INCIDENTS).orderBy('createdAt', 'desc').limit(limit).get()
  const all = snap.docs.map(d => toView(d.data() as IncidentDoc))
  return opts?.status ? all.filter(i => i.status === opts.status) : all
}

/** Count of incidents not yet resolved (open + investigating). */
export async function countOpenIncidents(): Promise<number> {
  try {
    const snap = await adminDb.collection(INCIDENTS).where('status', 'in', ['open', 'investigating']).count().get()
    return snap.data().count
  } catch { return -1 }
}

export async function createIncident(
  adminUid: string, input: { title: string; description?: string; severity: IncidentSeverity },
): Promise<IncidentView> {
  const ref = adminDb.collection(INCIDENTS).doc()
  const doc: IncidentDoc = {
    incidentId: ref.id,
    title:      input.title.trim().slice(0, 200),
    description: (input.description ?? '').slice(0, 5000),
    severity:   input.severity,
    status:     'open',
    postmortem: '',
    createdBy:  adminUid,
    createdAt:  FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
    resolvedAt: null,
  }
  await ref.set(doc)
  const snap = await ref.get()
  return toView(snap.data() as IncidentDoc)
}

export async function updateIncident(
  adminUid: string, incidentId: string, patch: { status?: IncidentStatus; postmortem?: string },
): Promise<IncidentView | null> {
  const ref = adminDb.collection(INCIDENTS).doc(incidentId)
  const snap = await ref.get()
  if (!snap.exists) return null

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (patch.status) {
    update.status = patch.status
    if (patch.status === 'resolved') { update.resolvedAt = FieldValue.serverTimestamp(); update.resolvedBy = adminUid }
  }
  if (typeof patch.postmortem === 'string') update.postmortem = patch.postmortem.slice(0, 20_000)
  await ref.set(update, { merge: true })
  const fresh = await ref.get()
  return toView(fresh.data() as IncidentDoc)
}
