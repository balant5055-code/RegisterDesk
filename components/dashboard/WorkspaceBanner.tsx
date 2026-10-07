'use client'

// Workspace chip — which workspace am I operating in?
//
// Owners see nothing (their own workspace is the default and needs no announcement).
// Team members see the organization name plus their role, because operating inside
// someone else's workspace is exactly the context you must never lose track of.
//
// RD-ORG-FOUNDATION: this used to make its own GET /api/organizer/workspace call. It
// now reads the SAME result the sidebar's permission gate already fetched, removing
// one of three identical requests a dashboard load was making. No behaviour change.

import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager', checkin_staff: 'Check-in Staff', finance: 'Finance',
}

export function WorkspaceBanner({ className }: { className?: string }) {
  const { info } = useWorkspacePermissions(true)

  // Owners get no chip. Showing "Personal Workspace" to the only person who could
  // possibly be there is noise on every page, and this bar is scarce space.
  if (!info || info.isOwner) return null

  return (
    <div
      aria-label="Current workspace"
      className={cn(
        'hidden items-center gap-1.5 rounded-control border border-border bg-muted/50 px-2 py-0.5 md:inline-flex',
        className,
      )}
    >
      <Building2 className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="max-w-[180px] truncate text-fs-xs font-medium text-foreground">
        {info.organizationName}
      </span>
      <span className="rounded-control bg-primary/10 px-1 py-0.5 text-fs-2xs font-semibold capitalize text-primary">
        {ROLE_LABEL[info.role] ?? info.role}
      </span>
    </div>
  )
}
