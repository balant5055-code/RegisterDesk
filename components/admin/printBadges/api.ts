'use client'

// RD-PRINT-BILL-P7 · Super Admin ID-badge views — one authed GET helper and the shared section type.
// Every endpoint used here is GET-only and Super Admin (ADMIN_UIDS) gated on the server.

import { auth } from '@/lib/firebase/auth'

/** Mirrors lib/admin/printBadgeAdmin/common.ts Section (kept client-side: no server import). */
export type Section<T> = { ok: true; data: T } | { ok: false; reason: 'unavailable' }
export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: string | null }

export async function adminGet<T>(url: string): Promise<T> {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Not authenticated')
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body
}

export const fmtWhen = (v: string | null): string =>
  v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
export const qty = (v: number | null | undefined): string => (typeof v === 'number' ? v.toLocaleString('en-IN') : '—')
