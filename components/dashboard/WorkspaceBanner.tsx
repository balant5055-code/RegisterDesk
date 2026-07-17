'use client'

import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { Building2, UserCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { WorkspaceInfoResponse } from '@/app/api/organizer/workspace/route'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager', checkin_staff: 'Check-in Staff', finance: 'Finance',
}

// Top-bar chip showing which workspace the user is operating in. Owners see
// "Personal Workspace"; team members see the organization name + a role badge.
export function WorkspaceBanner() {
  const [info, setInfo] = useState<WorkspaceInfoResponse | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setInfo(null); return }
      try {
        const token = await user.getIdToken()
        const res = await fetch('/api/organizer/workspace', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (res.ok) setInfo(await res.json() as WorkspaceInfoResponse)
      } catch { /* banner is non-critical */ }
    })
    return unsub
  }, [])

  if (!info) return null

  return (
    <div className="hidden items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1 md:inline-flex" aria-label="Current workspace">
      {info.isOwner
        ? <UserCircle className="size-4 text-muted-foreground" aria-hidden />
        : <Building2 className="size-4 text-primary" aria-hidden />}
      <span className="max-w-[180px] truncate text-[13px] font-medium text-foreground">{info.organizationName}</span>
      {!info.isOwner && (
        <span className={cn('rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold capitalize ring-1', 'bg-primary/[0.08] text-primary ring-primary/20')}>
          {ROLE_LABEL[info.role] ?? info.role}
        </span>
      )}
    </div>
  )
}
