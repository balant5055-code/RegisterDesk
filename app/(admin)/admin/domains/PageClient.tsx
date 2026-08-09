'use client'

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, Globe } from 'lucide-react'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import type { AdminDomainRow, CustomDomainStatus } from '@/lib/domains/types'

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

const STATUS_TONE: Record<CustomDomainStatus, PillTone> = {
  verified: 'success',
  failed:   'danger',
  pending:  'warning',
}

export default function AdminDomainsPage() {
  const [rows,    setRows]    = useState<AdminDomainRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    const u = auth.currentUser
    ;(async () => {
      if (!u) { setError('Not authenticated'); setLoading(false); return }
      try {
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/domains', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        setRows(((await res.json()) as { domains: AdminDomainRow[] }).domains)
      } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
    })()
  }, [])

  return (
    <div className="space-y-5">
      <AdminToolbar icon={Globe} title="Custom Domains" description="All organizer custom domains and their verification status." />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <TableFrame minWidth="min-w-[680px]">
        <THead>
          <Th>Domain</Th><Th>Organizer</Th><Th>Status</Th><Th>SSL</Th><Th>Verified</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={5}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : rows.length === 0 ? (
            <TableStateRow colSpan={5}>No custom domains.</TableStateRow>
          ) : rows.map(r => (
            <Tr key={r.organizerUid}>
              <Td className="font-mono text-foreground">{r.customDomain}</Td>
              <Td className="font-mono text-[12px] text-muted-foreground">{r.organizerUid}</Td>
              <Td><StatusPill tone={STATUS_TONE[r.status]}>{r.status}</StatusPill></Td>
              <Td className="capitalize text-muted-foreground">{r.sslStatus ?? '—'}</Td>
              <Td className="text-muted-foreground">{fmt(r.verifiedAt)}</Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>
    </div>
  )
}
