'use client'

// RD-RACEOPS-01 · Race Operations — access gate.
//
// Wraps every Race Operations page. Renders children only for the workspace owner
// or an `admin` team member, matching the server's `requireAdmin`. Composed
// entirely from existing primitives (Spinner, EmptyState) — no new visual language.
//
// This is UI gating. It is not the security boundary: from Sprint 3 the module's
// route handlers enforce `requireAdmin` server-side, which is authoritative.

import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { EmptyState, Spinner } from '@/components/ui'
import { useRaceOpsAccess } from '@/features/race-operations/hooks/useRaceOpsAccess'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager',
  checkin_staff: 'Check-in Staff', finance: 'Finance',
}

export function RaceOpsAccessGate({ children }: { children: ReactNode }) {
  const { allowed, role } = useRaceOpsAccess()

  if (allowed === undefined) {
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

  return <>{children}</>
}
