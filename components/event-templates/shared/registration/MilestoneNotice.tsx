// The ONE visual for a Booking Milestone Alert, shared by every event template.
//
// WHY THIS EXISTS AS A COMPONENT. Eight templates render pass cards with genuinely different
// layouts. Without a shared component each would grow its own copy of the same conditional and
// they would drift — different wording, different tone mapping, one template forgetting to
// escape. The resolved alert is computed once on the server; this renders it once too, so the
// only per-template work is choosing WHERE to place it.
//
// PRESENTATION ONLY. Rendering this cannot change price, availability, capacity, selection or
// checkout. It has no state, no effects and no callbacks — there is nothing here for a
// registration flow to depend on.

import { Info } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { ResolvedMilestoneAlert } from '@/lib/events/milestoneAlerts'

/**
 * Tone → colour, mapped to the SAME palette the platform's Banner already uses, so a notice
 * looks native next to every other inline message rather than introducing a parallel scale.
 * Deliberately muted: this is informational, and must never read as an error or a warning
 * about the attendee's own registration.
 */
const TONE = {
  info:    'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-100',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100',
} as const

export interface MilestoneNoticeProps {
  /** The already-resolved alert, or null/undefined for none. */
  alert?:     ResolvedMilestoneAlert | null
  className?: string
}

/**
 * Renders the pass's current milestone notice, or nothing.
 *
 * `role="status"` (not `alert`) because this is ambient information the attendee did not
 * trigger — an assertive live region would interrupt a screen-reader user mid-form for a
 * message that is not about them.
 *
 * The organizer's message is interpolated as a TEXT CHILD, so React escapes it. There is no
 * dangerouslySetInnerHTML here and there must never be: the string is organizer-supplied and
 * reaches a public page.
 */
export function MilestoneNotice({ alert, className }: MilestoneNoticeProps) {
  if (!alert || !alert.message) return null

  return (
    <div
      role="status"
      data-testid="milestone-notice"
      className={cn(
        'mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed',
        TONE[alert.tone] ?? TONE.info,
        className,
      )}
    >
      <Info className="mt-[1px] size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block font-semibold">Participant Notice</span>
        <span className="block">{alert.message}</span>
      </span>
    </div>
  )
}
