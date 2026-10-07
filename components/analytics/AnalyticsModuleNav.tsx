'use client'

// RD-ANALYTICS-12-13 · the strip that makes the Analytics modules reachable.
//
// ═══ WHY THIS IS THE WHOLE CHANGE ════════════════════════════════════════════
// Five Analytics modules shipped across RD-ANALYTICS-06/08/09/10/11, each with its own
// route, its own tests and its own browser QA — and the 12-12 audit found ZERO navigable
// references to any of them. Nothing was broken; nothing linked. This component is the
// missing link, and deliberately nothing more: no layout change, no data, no gating, no
// redesign of a module that was already audited.
//
// ═══ WHY IT IS NOT A TAB COMPONENT ═══════════════════════════════════════════
// Each module is a real route with its own page, so these are LINKS, not tabs — a `<nav>`
// of anchors that survive a middle-click, a bookmark and a back button. Rendering them with
// `role="tablist"` would claim a widget contract (arrow-key roving focus, shared panel)
// that five separate documents cannot honour. `aria-current="page"` is the correct signal.
//
// The event context rides along in the query string because every module is event-scoped
// and reads `?eventId=`; dropping it on a module switch would silently move the reader to a
// different event's numbers, which is the failure `EVENT_PARAM` exists to prevent.

import { useContext } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { ANALYTICS_MODULES } from '@/lib/analytics/routes'
import { EVENT_PARAM } from '@/lib/events/eventContext'
import { AnalyticsScopeContext } from './useAnalyticsScope'

/**
 * RD-ANALYTICS-12-33 · modules the payload does not offer are not listed.
 *
 * `capabilities.modules` is the server's own answer — finance-gated Revenue, gate-dependent
 * Operations and Communications, data-gated Participants — computed by the existing
 * `availableAnalyticsModules` and carried in every payload. The strip reads it through the
 * page's shared scope (never a second fetch) and hides what the event cannot support, so a
 * reader is not offered a tab that opens onto "not available". Before the payload arrives
 * every module is listed; Insights, which is derived from the payload rather than gated by
 * it, is always listed. Nothing here decides access: a hidden tab's route still renders its
 * own denied or unavailable state if visited directly.
 */
const ALWAYS = new Set(['insights', 'overview'])

export function AnalyticsModuleNav() {
  const pathname = usePathname()
  const params   = useSearchParams()
  const eventId  = params.get(EVENT_PARAM)
  const scope    = useContext(AnalyticsScopeContext)
  const offered  = scope?.data?.capabilities.modules ?? null
  const modules  = offered
    ? ANALYTICS_MODULES.filter(m => ALWAYS.has(m.key) || (offered as string[]).includes(m.key))
    : ANALYTICS_MODULES

  return (
    <nav
      aria-label="Analytics modules"
      // Scrolls rather than wraps or clips: five labels do not fit at 390px, and a wrapped
      // second row pushes the module's own header below the fold on a phone.
      className="-mx-1 overflow-x-auto px-1 pb-px"
    >
      <ul className="flex min-w-max items-center gap-1 border-b border-border">
        {modules.map(m => {
          const active = pathname === m.href
          const href   = eventId ? `${m.href}?${EVENT_PARAM}=${encodeURIComponent(eventId)}` : m.href
          return (
            <li key={m.key}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex min-h-10 items-center whitespace-nowrap border-b-2 px-3 py-2',
                  'text-fs-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]',
                  // Border, weight AND colour — never colour alone.
                  active
                    ? 'border-[color:var(--primary)] font-semibold text-[color:var(--primary-text)]'
                    : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
                )}
              >
                {m.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
