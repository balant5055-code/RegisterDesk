'use client'

// RD-RACEOPS-01 · Race Operations — access gate.
//
// Wraps every Race Operations page. Renders children only for the workspace owner
// or an `admin` team member, matching the server's `requireAdmin`. Composed
// entirely from existing primitives (Spinner, EmptyState) — no new visual language.
//
// RD-RACEOPS-02B · and only for an event that HOLDS the capability. The person's role and
// the event's type are two independent gates, both evaluated here, both re-applied by the
// server. The event is the one the shell's selector holds (`useEventContext`): a direct
// URL carrying `?event=<conference>` lands on the same refusal the sidebar already
// expressed by hiding the row, and switching the selector to a conference removes the
// children without a reload. With no event selected ("All events") the pages render and
// their own event list offers sports events only.
//
// This is UI gating. It is not the security boundary: the module's route handlers
// enforce `requireAdmin` and `resolveRace` / `resolveRaceOpsEvent` server-side, which
// are authoritative.

import type { ReactNode } from 'react'
import { ShieldAlert, Flag } from 'lucide-react'
import { EmptyState, Spinner } from '@/components/ui'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { isRaceOperationsAvailable } from '@/lib/events/eventCapabilities'
import { EVENT_TYPE_NAMES } from '@/lib/events/taxonomy'
import { ALL_EVENTS_HREF } from '@/config/workspaceNav'
import { useRaceOpsAccess } from '@/features/race-operations/hooks/useRaceOpsAccess'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager',
  checkin_staff: 'Check-in Staff', finance: 'Finance',
}

export function RaceOpsAccessGate({ children }: { children: ReactNode }) {
  const { allowed, role } = useRaceOpsAccess()
  const { selectedEvent, loading: eventsLoading } = useEventContext()

  if (allowed === undefined || (eventsLoading && selectedEvent === null)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner label="Checking your access" />
      </div>
    )
  }

  if (!allowed) {
    const roleLabel = role ? (ROLE_LABEL[role] ?? role) : null
    return (
      <EmptyState
        icon={ShieldAlert}
        size="lg"
        title="Race Operations is restricted"
        description={
          roleLabel
            ? `Only the workspace owner and Admin team members can publish race results. Your role is ${roleLabel}.`
            : 'Only the workspace owner and Admin team members can publish race results.'
        }
        action={{ label: 'Back to dashboard', href: '/dashboard' }}
      />
    )
  }

  // The event's capability — decided by the same rule as the sidebar row and the routes.
  if (selectedEvent && !isRaceOperationsAvailable(selectedEvent.eventType)) {
    const typeName = selectedEvent.eventType ? EVENT_TYPE_NAMES[selectedEvent.eventType] : null
    return (
      <EmptyState
        icon={Flag}
        size="lg"
        title="Race Operations is not available for this event"
        description={
          typeName
            ? `${selectedEvent.name} is a ${typeName} event. Race results can be published for sports events only — choose a sports event to continue.`
            : `Race results can be published for sports events only — choose a sports event to continue.`
        }
        action={{ label: 'Choose another event', href: ALL_EVENTS_HREF }}
      />
    )
  }

  return <>{children}</>
}
