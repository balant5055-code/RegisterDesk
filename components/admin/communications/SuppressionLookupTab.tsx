'use client'

// Super Admin › Communication Center › Suppression (RD-COMMS-P2-G). READ-ONLY investigation.
//
// One address at a time: the platform record (SES bounce / complaint — blocks every sender), each
// organizer's opt-out, and the opt-out history (audit rows hold a hash of the address, never the
// address). Served by GET /api/admin/communications/suppression (ADMIN_UIDS). There is no override
// control: a platform suppression is not lifted from the UI.

import { useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import type { SuppressionInvestigation } from '@/lib/firebase/firestore/emailSuppressionList'

/** RD-COMMS-WA-CONSENT — a number's organizer-broadcast opt-out (STOP/START). */
interface WhatsAppOptOutView {
  state:   { state: string; keyword: string | null; changedAt: string | null } | null
  history: { action: string; keyword: string | null; applied: boolean; at: string | null }[]
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

export function SuppressionLookupTab() {
  const [email, setEmail]   = useState('')
  const [busy, setBusy]     = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [result, setResult] = useState<SuppressionInvestigation | null>(null)
  const [phone, setPhone]     = useState('')
  const [wa, setWa]           = useState<WhatsAppOptOutView | null>(null)
  const [waError, setWaError] = useState<string | null>(null)

  async function lookupPhone(e: React.FormEvent) {
    e.preventDefault()
    setWaError(null); setWa(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch(`/api/admin/communications/suppression?phone=${encodeURIComponent(phone.trim())}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
      const body = await res.json().catch(() => ({})) as { whatsapp?: WhatsAppOptOutView; error?: string }
      if (!res.ok || !body.whatsapp) throw new Error(body.error ?? 'Lookup failed')
      setWa(body.whatsapp)
    } catch (err) { setWaError(err instanceof Error ? err.message : 'Lookup failed') }
  }

  async function lookup(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null); setResult(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch(`/api/admin/communications/suppression?email=${encodeURIComponent(email.trim())}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
      const body = await res.json().catch(() => ({})) as SuppressionInvestigation & { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Lookup failed')
      setResult(body)
    } catch (err) { setError(err instanceof Error ? err.message : 'Lookup failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">Why is email not reaching an address? Look it up across the platform suppression list and every organizer’s opt-outs. Read-only.</p>
      <form onSubmit={lookup} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="suppression-email">Email address</label>
        <input id="suppression-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground" />
        <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />} Look up
        </button>
      </form>
      {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}

      {/* RD-COMMS-WA-CONSENT — WhatsApp: organizer broadcasts need an explicit opt-in at registration;
          a STOP from the number blocks them until the same number sends START. */}
      <form onSubmit={lookupPhone} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="suppression-phone">WhatsApp number</label>
        <input id="suppression-phone" type="tel" required value={phone} onChange={e => setPhone(e.target.value)} placeholder="WhatsApp number, e.g. +91 98…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground" />
        <button type="submit" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-semibold text-foreground hover:bg-muted">
          <Search className="size-4" aria-hidden /> Look up WhatsApp
        </button>
      </form>
      {waError && <p role="alert" className="text-[13px] text-destructive">{waError}</p>}
      {wa && (
        <div className="rounded-xl border border-border bg-card p-4 text-[13px]">
          <p className="font-semibold text-foreground">WhatsApp broadcast opt-out</p>
          <p className="mt-1 text-muted-foreground">
            {wa.state?.state === 'opted_out'
              ? <>Opted out (replied <span className="font-semibold text-foreground">{wa.state.keyword}</span>) — no organizer broadcast reaches this number{wa.state.changedAt ? ` · since ${fmt(wa.state.changedAt)}` : ''}.</>
              : wa.state ? <>Opted back in (replied {wa.state.keyword}){wa.state.changedAt ? ` · ${fmt(wa.state.changedAt)}` : ''}. Broadcasts still need the attendee’s opt-in at registration.</>
              : 'No STOP on record. Broadcasts still need the attendee’s opt-in at registration.'}
          </p>
          {wa.history.length > 0 && (
            <ul className="mt-1.5 space-y-1 text-muted-foreground">
              {wa.history.map((h, i) => <li key={i}>{fmt(h.at)} · {h.action === 'opt_out' ? 'STOP' : 'START'} ({h.keyword}){h.applied ? '' : ' · older than the current state, not applied'}</li>)}
            </ul>
          )}
        </div>
      )}

      {result && (
        <div className="space-y-3 text-[13px]">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="font-semibold text-foreground">Platform suppression</p>
            {result.platform
              ? <p className="mt-1 text-muted-foreground">Blocked for every sender — <span className="font-semibold text-foreground">{result.platform.reason}</span>{result.platform.bounceType ? ` (${result.platform.bounceType})` : ''}{result.platform.complaintType ? ` (${result.platform.complaintType})` : ''} · since {fmt(result.platform.createdAt)}</p>
              : <p className="mt-1 text-muted-foreground">Not suppressed platform-wide.</p>}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <p className="font-semibold text-foreground">Organizer opt-outs · {result.organizers.length}</p>
            {result.organizers.length === 0 ? <p className="mt-1 text-muted-foreground">None.</p> : (
              <ul className="mt-1.5 space-y-1">
                {result.organizers.map(o => (
                  <li key={o.organizerUid} className="break-all text-muted-foreground">
                    <span className="font-mono text-[12px] text-foreground">{o.organizerUid}</span> · {o.kind === 'unsubscribed' ? 'unsubscribed' : `not deliverable (${o.reason})`}{o.eventSlug ? ` · from ${o.eventSlug}` : ''} · {fmt(o.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <p className="font-semibold text-foreground">Opt-out history · {result.audit.length}</p>
            {result.audit.length === 0 ? <p className="mt-1 text-muted-foreground">No recorded changes.</p> : (
              <ul className="mt-1.5 space-y-1">
                {result.audit.map((a, i) => (
                  <li key={i} className="break-all text-muted-foreground">
                    {fmt(a.at)} · <span className="font-semibold text-foreground">{a.action === 'opt_in' ? 'opted back in' : 'opted out'}</span> · {a.scope}{a.organizerUid ? ` ${a.organizerUid}` : ''}{a.source ? ` · via ${a.source.replace(/_/g, ' ')}` : ''}{a.eventSlug ? ` · ${a.eventSlug}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
