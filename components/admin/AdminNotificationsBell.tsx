'use client'

// Wallet-02 — the admin header bell. Super Admins (ADMIN_UIDS) see the purchase notifications feed
// (GET /api/admin/notifications) with an unread badge; everyone keeps the existing "Incidents &
// alerts" link, so a legacy admin sees exactly what the bell linked to before.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell, ShieldAlert } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

interface Item { id: string; title: string; body: string; href: string | null; createdAt: string | null; read: boolean }

async function call(method: 'GET' | 'POST', body?: unknown) {
  const token = await auth.currentUser?.getIdToken().catch(() => null)
  if (!token) return null
  const res = await fetch('/api/admin/notifications', {
    method, cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null)
  return res
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

export function AdminNotificationsBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[] | null>(null)     // null = not a Super Admin / not loaded
  const [unread, setUnread] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const res = await call('GET')
    if (!res || !res.ok) { setItems(null); setUnread(0); return }
    const body = await res.json().catch(() => null) as { items?: Item[]; unread?: number } | null
    setItems(body?.items ?? []); setUnread(body?.unread ?? 0)
  }, [])
  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    const i = setInterval(() => { void load() }, 120_000)
    return () => { clearTimeout(t); clearInterval(i) }
  }, [load])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const markAll = async () => {
    const ids = (items ?? []).filter(i => !i.read).map(i => i.id)
    if (ids.length === 0) return
    await call('POST', { ids })
    await load()
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-expanded={open} aria-haspopup="true"
        className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <Bell className="size-[18px]" aria-hidden />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          {items !== null && (
            <>
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <p className="text-[13px] font-semibold text-foreground">Purchases</p>
                {unread > 0 && <button type="button" onClick={() => void markAll()} className="text-[12px] font-semibold text-primary hover:underline">Mark all read</button>}
              </div>
              <ul className="max-h-80 overflow-y-auto">
                {items.length === 0 ? <li className="px-3 py-4 text-[12.5px] text-muted-foreground">No notifications yet.</li>
                  : items.map(i => (
                    <li key={i.id} className={cn('border-b border-border/60 px-3 py-2 last:border-0', !i.read && 'bg-primary/[0.04]')}>
                      <Link href={i.href ?? ROUTES.ADMIN_INCIDENTS} onClick={() => { setOpen(false); if (!i.read) void call('POST', { ids: [i.id] }).then(load) }} className="block">
                        <p className="text-[12.5px] font-medium text-foreground">{i.title}</p>
                        <p className="text-[12px] text-muted-foreground">{i.body}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{when(i.createdAt)}</p>
                      </Link>
                    </li>
                  ))}
              </ul>
            </>
          )}
          <Link href={ROUTES.ADMIN_INCIDENTS} onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-[12.5px] font-medium text-foreground hover:bg-muted">
            <ShieldAlert className="size-3.5 text-muted-foreground" aria-hidden />Incidents &amp; alerts
          </Link>
        </div>
      )}
    </div>
  )
}
