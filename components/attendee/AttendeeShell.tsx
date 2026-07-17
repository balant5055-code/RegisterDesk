'use client'

import { useCallback, useEffect, useState } from 'react'
import Link                    from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn }                  from '@/lib/utils/cn'
import { useToast }            from '@/components/ui/Toast'
import {
  LayoutDashboard, ClipboardList, Ticket, Heart, Award, LogOut, Menu, X, ShieldCheck,
} from 'lucide-react'

const NAV = [
  { href: '/attendee',               label: 'Dashboard',     icon: LayoutDashboard, exact: true },
  { href: '/attendee/registrations', label: 'Registrations', icon: ClipboardList },
  { href: '/attendee/tickets',       label: 'Tickets',       icon: Ticket },
  { href: '/attendee/donations',     label: 'Donations',     icon: Heart },
  { href: '/attendee/certificates',  label: 'Certificates',  icon: Award },
] as const

type State = 'loading' | 'authed' | 'redirecting'

export default function AttendeeShell({ children }: { children: React.ReactNode }) {
  const router   = useRouter()
  const pathname = usePathname()
  const { showToast } = useToast()
  const [state, setState] = useState<State>('loading')
  const [email, setEmail] = useState('')
  const [drawer, setDrawer] = useState(false)

  // Server-validated session — never trust client state. Promise-chain (not
  // async/await) so setState runs in deferred callbacks, not the effect body.
  const checkSession = useCallback(() => {
    fetch('/api/attendee/me', { cache: 'no-store' })
      .then(res => res.json() as Promise<{ authenticated: boolean; email?: string }>)
      .then(data => {
        if (!data.authenticated) { setState('redirecting'); router.replace('/attendee/login'); return }
        setEmail(data.email ?? '')
        setState('authed')
      })
      .catch(() => { setState('redirecting'); router.replace('/attendee/login') })
  }, [router])

  useEffect(() => {
    const t = setTimeout(checkSession, 0)
    return () => clearTimeout(t)
  }, [checkSession])

  async function handleLogout() {
    try { await fetch('/api/attendee/logout', { method: 'POST' }) } catch { /* ignore */ }
    showToast('Signed out.', 'info')
    router.replace('/attendee/login')
  }

  if (state !== 'authed') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="size-7 animate-spin rounded-full border-2 border-border border-t-primary" aria-label="Loading" />
      </div>
    )
  }

  const initial = (email[0] ?? 'A').toUpperCase()

  return (
    <div className="min-h-screen bg-background">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-40 flex h-[56px] items-center gap-3 border-b border-border bg-card px-4 shadow-sm md:px-6">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted md:hidden"
          aria-label="Open menu"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-[7px] text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>
            <span className="text-[9px] font-extrabold tracking-[0.1em]">RD</span>
          </div>
          <span className="text-[14px] font-bold tracking-tight text-foreground">RegisterDesk</span>
        </div>
        <div className="ml-auto flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5">
          <div className="flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-primary-foreground" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>{initial}</div>
          <span className="hidden max-w-[180px] truncate text-[13px] font-medium text-foreground sm:block">{email}</span>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-0 md:gap-6 md:px-6 md:py-6">
        {/* ── Desktop sidebar ── */}
        <aside className="hidden w-56 shrink-0 md:block">
          <nav className="sticky top-[72px] flex flex-col gap-1" aria-label="Attendee navigation">
            {NAV.map(item => <NavLink key={item.href} {...item} pathname={pathname} />)}
            <button onClick={handleLogout} className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <LogOut className="size-4" aria-hidden /> Logout
            </button>
          </nav>
        </aside>

        {/* ── Mobile drawer ── */}
        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
            <nav className="absolute left-0 top-0 flex h-full w-64 flex-col gap-1 bg-card p-4 shadow-xl" aria-label="Attendee navigation">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" aria-hidden /><span className="text-[13px] font-semibold text-foreground">My Account</span></div>
                <button onClick={() => setDrawer(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close menu"><X className="size-4" /></button>
              </div>
              {NAV.map(item => <NavLink key={item.href} {...item} pathname={pathname} onNavigate={() => setDrawer(false)} />)}
              <button onClick={handleLogout} className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <LogOut className="size-4" aria-hidden /> Logout
              </button>
            </nav>
          </div>
        )}

        {/* ── Content ── */}
        <main className="min-w-0 flex-1 px-4 py-5 md:px-0 md:py-0">{children}</main>
      </div>
    </div>
  )
}

function NavLink({ href, label, icon: Icon, exact, pathname, onNavigate }: {
  href: string; label: string; icon: React.ElementType; exact?: boolean; pathname: string; onNavigate?: () => void
}) {
  const active = exact ? pathname === href : pathname.startsWith(href)
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors',
        active ? 'bg-primary/[0.08] text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden /> {label}
    </Link>
  )
}
