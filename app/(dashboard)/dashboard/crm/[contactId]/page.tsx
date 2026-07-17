'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { ArrowLeft, Loader2, Save, Ticket, ScanLine, Award, Heart, RotateCcw, Mail } from 'lucide-react'
import type { CrmContactView, CrmActivityView, CrmActivityType } from '@/lib/crm/types'

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

const ACT: Record<CrmActivityType, { label: string; icon: React.ElementType; color: string }> = {
  registration_created: { label: 'Registered', icon: Ticket, color: 'text-blue-600' },
  checked_in:           { label: 'Checked in', icon: ScanLine, color: 'text-emerald-600' },
  certificate_issued:   { label: 'Certificate issued', icon: Award, color: 'text-amber-600' },
  donation_created:     { label: 'Donated', icon: Heart, color: 'text-rose-600' },
  donation_refunded:    { label: 'Donation refunded', icon: RotateCcw, color: 'text-orange-600' },
  broadcast_sent:       { label: 'Broadcast sent', icon: Mail, color: 'text-violet-600' },
}

export default function CrmContactPage() {
  const { showToast } = useToast()
  const params = useParams<{ contactId: string }>()
  const contactId = params.contactId
  const userRef = useRef<User | null>(null)
  const [contact, setContact] = useState<CrmContactView | null>(null)
  const [timeline, setTimeline] = useState<CrmActivityView[]>([])
  const [canWrite, setCanWrite] = useState(false)
  const [notes, setNotes] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const u = userRef.current
    if (!u) return
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`/api/organizer/crm/contacts/${contactId}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (res.status === 404) throw new Error('Contact not found.')
      if (res.status === 403) throw new Error('CRM is not available for your role.')
      if (!res.ok) throw new Error('Could not load contact.')
      const d = await res.json() as { contact: CrmContactView; timeline: CrmActivityView[]; canWrite: boolean }
      setContact(d.contact); setTimeline(d.timeline); setCanWrite(d.canWrite)
      setNotes(d.contact.notes); setTags(d.contact.tags)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
  }, [contactId])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { userRef.current = u; if (u) void load() })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    const u = userRef.current
    if (!u) return
    setSaving(true)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`/api/organizer/crm/contacts/${contactId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes, tags }),
      })
      if (!res.ok) { const e = await res.json().catch(() => null) as { error?: string } | null; throw new Error(e?.error ?? 'Save failed.') }
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') } finally { setSaving(false) }
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t) && tags.length < 20) setTags([...tags, t])
    setTagInput('')
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !contact) return (
    <div className="p-6">
      <Link href="/dashboard/crm" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Back to CRM</Link>
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">{error ?? 'Not found'}</div>
    </div>
  )

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <Link href="/dashboard/crm" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Back to CRM</Link>

      {/* Profile */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h1 className="text-[20px] font-bold text-foreground">{contact.name || contact.email}</h1>
        <p className="text-[13.5px] text-muted-foreground">{contact.email}{contact.phone ? ` · ${contact.phone}` : ''}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Registrations" value={String(contact.totalRegistrations)} />
          <Stat label="Check-ins" value={String(contact.totalCheckIns)} />
          <Stat label="Donations" value={String(contact.totalDonations)} />
          <Stat label="Donation value" value={inr(contact.totalDonationAmountPaise)} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-muted-foreground">
          <span>First seen: {fmtDate(contact.firstSeenAt)}</span>
          <span>Last seen: {fmtDate(contact.lastSeenAt)}</span>
          {contact.lastEvent && <span>Last event: {contact.lastEvent.name}</span>}
          {contact.lastDonation && <span>Last donation: {inr(contact.lastDonation.amountPaise)} to {contact.lastDonation.campaign}</span>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* Timeline */}
        <div>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Timeline</h2>
          {timeline.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-10 text-center text-[13px] text-muted-foreground">No activity yet.</p>
          ) : (
            <ol className="space-y-2">
              {timeline.map((a, i) => {
                const meta = ACT[a.type]
                const Icon = meta.icon
                return (
                  <li key={i} className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3">
                    <Icon className={cn('mt-0.5 size-4 shrink-0', meta.color)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium text-foreground">{meta.label}
                        {typeof a.metadata.amountPaise === 'number' && <span className="ml-1 text-muted-foreground">· {inr(a.metadata.amountPaise as number)}</span>}
                      </p>
                      <p className="text-[12px] text-muted-foreground">
                        {typeof a.metadata.eventName === 'string' && a.metadata.eventName ? `${a.metadata.eventName} · ` : ''}
                        {typeof a.metadata.campaignTitle === 'string' && a.metadata.campaignTitle ? `${a.metadata.campaignTitle} · ` : ''}
                        {fmtDate(a.createdAt)}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        {/* Notes + Tags */}
        <div className="space-y-4">
          <div>
            <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</h2>
            <div className="flex flex-wrap gap-1.5">
              {tags.map(t => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[12px] text-foreground">
                  {t}{canWrite && <button onClick={() => setTags(tags.filter(x => x !== t))} className="text-muted-foreground hover:text-destructive">×</button>}
                </span>
              ))}
              {tags.length === 0 && <span className="text-[12.5px] text-muted-foreground">No tags</span>}
            </div>
            {canWrite && (
              <div className="mt-2 flex gap-2">
                <input value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                  placeholder="Add tag" className="flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" />
                <button onClick={addTag} className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-muted">Add</button>
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</h2>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} disabled={!canWrite} rows={6}
              placeholder={canWrite ? 'Add private notes about this contact…' : 'No notes'}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] disabled:opacity-70" />
          </div>

          {canWrite && (
            <button onClick={() => void save()} disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-[16px] font-bold text-foreground">{value}</p>
    </div>
  )
}
