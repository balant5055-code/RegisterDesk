'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { uploadOrganizerAsset } from '@/lib/firebase/storage'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { cn } from '@/lib/utils/cn'
import { Loader2, Palette, Globe, Check, AlertCircle, Lock, RefreshCw, Trash2 } from 'lucide-react'
import type { Branding } from '@/lib/branding/types'
import type { DomainConfig, CustomDomainStatus } from '@/lib/domains/types'

const HEX = /^#[0-9a-fA-F]{6}$/

export default function BrandingPage() {
  const userRef = useRef<User | null>(null)
  const { confirm } = useConfirm()
  const [gated,   setGated]   = useState<boolean | null>(null)   // null=loading, false=no whiteLabel
  const [loading, setLoading] = useState(true)

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const u = userRef.current
    if (!u) throw new Error('Not signed in.')
    const token = await u.getIdToken()
    return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
  }, [])

  // Branding state
  const [branding, setBranding] = useState<Branding | null>(null)
  const [bSaving,  setBSaving]  = useState(false)
  const [bMsg,     setBMsg]     = useState<string | null>(null)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [favFile,  setFavFile]  = useState<File | null>(null)

  // Domain state
  const [domain,    setDomain]    = useState<DomainConfig | null>(null)
  const [domainGated, setDomainGated] = useState<boolean>(true)
  const [domainInput, setDomainInput] = useState('')
  const [dBusy,     setDBusy]     = useState(false)
  const [dMsg,      setDMsg]      = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const bRes = await authedFetch('/api/organizer/branding')
      if (bRes.status === 402) { setGated(false); setLoading(false); return }
      setGated(true)
      if (bRes.ok) setBranding(((await bRes.json()) as { branding: Branding }).branding)

      const dRes = await authedFetch('/api/organizer/domain')
      if (dRes.status === 402) setDomainGated(false)
      else if (dRes.ok) { setDomainGated(true); const d = (await dRes.json()) as { config: DomainConfig }; setDomain(d.config); setDomainInput(d.config.customDomain ?? '') }
    } catch { /* keep nulls */ } finally { setLoading(false) }
  }, [authedFetch])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      userRef.current = user
      if (!user) { setLoading(false); setGated(false); return }
      void loadAll()
    })
    return unsub
  }, [loadAll])

  async function saveBranding() {
    if (!branding) return
    setBSaving(true); setBMsg(null)
    try {
      const uid = userRef.current?.uid
      let logoUrl = branding.logoUrl, faviconUrl = branding.faviconUrl
      if (uid && logoFile) { logoUrl = await uploadOrganizerAsset(uid, 'logo', logoFile); setLogoFile(null) }
      if (uid && favFile)  { faviconUrl = await uploadOrganizerAsset(uid, 'logo', favFile); setFavFile(null) }
      const res = await authedFetch('/api/organizer/branding', { method: 'PUT', body: JSON.stringify({ ...branding, logoUrl, faviconUrl }) })
      const data = await res.json().catch(() => null) as { branding?: Branding; error?: string } | null
      if (!res.ok || !data?.branding) throw new Error(data?.error ?? 'Save failed.')
      setBranding(data.branding); setBMsg('Saved.')
    } catch (e) { setBMsg(e instanceof Error ? e.message : 'Save failed') } finally { setBSaving(false) }
  }

  async function saveDomain() {
    setDBusy(true); setDMsg(null)
    try {
      const res = await authedFetch('/api/organizer/domain', { method: 'POST', body: JSON.stringify({ domain: domainInput }) })
      const data = await res.json().catch(() => null) as { config?: DomainConfig; error?: string } | null
      if (!res.ok || !data?.config) throw new Error(data?.error ?? 'Failed.')
      setDomain(data.config)
    } catch (e) { setDMsg(e instanceof Error ? e.message : 'Failed') } finally { setDBusy(false) }
  }
  async function verifyDomain() {
    setDBusy(true); setDMsg(null)
    try {
      const res = await authedFetch('/api/organizer/domain/verify', { method: 'POST' })
      const data = await res.json().catch(() => null) as { config?: DomainConfig; error?: string } | null
      if (data?.config) setDomain(data.config)
      if (!res.ok) setDMsg(data?.error ?? 'Verification pending.')
    } catch (e) { setDMsg(e instanceof Error ? e.message : 'Failed') } finally { setDBusy(false) }
  }
  async function deleteDomain() {
    if (!(await confirm({ message: 'Remove this custom domain?', tone: 'danger' }))) return
    setDBusy(true); setDMsg(null)
    try {
      const res = await authedFetch('/api/organizer/domain', { method: 'DELETE' })
      const data = await res.json().catch(() => null) as { config?: DomainConfig } | null
      if (data?.config) { setDomain(data.config); setDomainInput('') }
    } finally { setDBusy(false) }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  if (gated === false) {
    return (
      <div className="space-y-6 p-5 sm:p-6">
        <Header />
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/[0.08]"><Lock className="size-6 text-primary" aria-hidden /></div>
          <p className="text-[16px] font-semibold text-foreground">White-label branding is a Pro feature</p>
          <p className="max-w-sm text-[13.5px] text-muted-foreground">Upgrade to Pro to customize your logo, colors, sender name, and remove RegisterDesk branding.</p>
          <a href="/dashboard/settings/billing" className="mt-2 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[14px] font-semibold text-primary-foreground shadow-sm hover:opacity-90" style={{ backgroundImage: 'var(--primary-gradient)' }}>View plans</a>
        </div>
      </div>
    )
  }

  const b = branding
  const set = (patch: Partial<Branding>) => setBranding(prev => prev ? { ...prev, ...patch } : prev)

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <Header />

      {/* ── Branding ── */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-4 flex items-center gap-2 text-[15px] font-bold text-foreground"><Palette className="size-4 text-primary" aria-hidden /> White Label</h2>
        {b && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-4">
              <Field label="Logo">
                <input type="file" accept="image/*" onChange={e => setLogoFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
                {b.logoUrl && <p className="mt-1 truncate text-[11.5px] text-muted-foreground">Current: {b.logoUrl}</p>}
              </Field>
              <Field label="Favicon">
                <input type="file" accept="image/*" onChange={e => setFavFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
                {b.faviconUrl && <p className="mt-1 truncate text-[11.5px] text-muted-foreground">Current: {b.faviconUrl}</p>}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Primary color"><ColorInput value={b.primaryColor} onChange={v => set({ primaryColor: v })} /></Field>
                <Field label="Secondary color"><ColorInput value={b.secondaryColor} onChange={v => set({ secondaryColor: v })} /></Field>
              </div>
              <Field label="Company name"><input value={b.companyName ?? ''} maxLength={100} onChange={e => set({ companyName: e.target.value || null })} className={inputCls} placeholder="Acme Events" /></Field>
              <Field label="Email sender name"><input value={b.emailSenderName ?? ''} maxLength={100} onChange={e => set({ emailSenderName: e.target.value || null })} className={inputCls} placeholder="Acme Events Team" /></Field>
              <label className="flex items-center gap-2 text-[13.5px]">
                <input type="checkbox" checked={b.hideRegisterDeskBranding} onChange={e => set({ hideRegisterDeskBranding: e.target.checked })} />
                Hide “Powered by RegisterDesk”
              </label>
              <div className="flex items-center gap-3">
                <button onClick={() => void saveBranding()} disabled={bSaving} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[14px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>{bSaving && <Loader2 className="size-4 animate-spin" />} Save branding</button>
                {bMsg && <span className="flex items-center gap-1 text-[12.5px] text-muted-foreground"><Check className="size-3.5" /> {bMsg}</span>}
              </div>
            </div>

            {/* White Label Preview */}
            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="px-4 py-3" style={{ background: b.primaryColor && HEX.test(b.primaryColor) ? b.primaryColor : 'var(--primary)' }}>
                  <span className="text-[11px] font-bold uppercase tracking-widest text-white opacity-90">{b.companyName || 'RegisterDesk'}</span>
                </div>
                <div className="space-y-2 bg-white p-4">
                  {b.logoUrl
                    // eslint-disable-next-line @next/next/no-img-element -- dynamic external Storage URL; next/image not configured for arbitrary org domains
                    ? <img src={b.logoUrl} alt="logo" className="h-8 w-auto" />
                    : <div className="h-8 w-24 rounded bg-muted" />}
                  <p className="text-[13px] font-semibold text-slate-800">Your event email</p>
                  <p className="text-[12px] text-slate-500">From: {b.emailSenderName || 'RegisterDesk'}</p>
                </div>
                <div className="bg-slate-50 px-4 py-2 text-center text-[10.5px] text-slate-400">
                  {b.hideRegisterDeskBranding ? '' : 'Powered by RegisterDesk'}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Custom Domain ── */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-4 flex items-center gap-2 text-[15px] font-bold text-foreground"><Globe className="size-4 text-primary" aria-hidden /> Custom Domain</h2>
        {!domainGated ? (
          <p className="text-[13.5px] text-muted-foreground">Custom domains are available on the Enterprise plan. <a href="/dashboard/settings/billing" className="font-semibold text-primary">View plans</a></p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex-1 min-w-[240px]"><span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Domain</span>
                <input value={domainInput} onChange={e => setDomainInput(e.target.value)} placeholder="events.yourbrand.com" className={cn(inputCls, 'font-mono')} /></label>
              <button onClick={() => void saveDomain()} disabled={dBusy || !domainInput.trim()} className="rounded-lg px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>Save</button>
              {domain?.customDomain && <button onClick={() => void deleteDomain()} disabled={dBusy} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2.5 text-[13px] font-medium text-red-600 hover:bg-muted"><Trash2 className="size-3.5" /> Remove</button>}
            </div>

            {domain?.customDomain && (
              <>
                <div className="flex items-center gap-2 text-[13px]">
                  Status: <DomainBadge status={domain.customDomainStatus} />
                  {domain.customDomainStatus !== 'verified' && (
                    <button onClick={() => void verifyDomain()} disabled={dBusy} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium hover:bg-muted">{dBusy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Verify DNS</button>
                  )}
                  {domain.customDomainSslStatus && <span className="text-[12px] text-muted-foreground">· SSL: {domain.customDomainSslStatus}</span>}
                </div>
                {dMsg && <p className="flex items-center gap-1.5 text-[12.5px] text-amber-700"><AlertCircle className="size-4" /> {dMsg}</p>}
                {domain.records.length > 0 && (
                  <div className="rounded-xl border border-border bg-muted/20 p-3">
                    <p className="mb-2 text-[12px] font-semibold text-muted-foreground">Add these DNS records at your registrar:</p>
                    <div className="space-y-1.5">
                      {domain.records.map((r, i) => (
                        <div key={i} className="grid grid-cols-[60px_1fr] gap-2 font-mono text-[12px]">
                          <span className="font-semibold text-foreground">{r.type}</span>
                          <span className="break-all text-muted-foreground"><span className="text-foreground">{r.name}</span> → {r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-[20px] font-bold tracking-tight text-foreground">Branding &amp; Domains</h1>
      <p className="text-[13.5px] text-muted-foreground">White-label your emails and pages, and connect a custom domain.</p>
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none focus:ring-2 focus:ring-primary/30'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">{label}</span>{children}</label>
}

function ColorInput({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={value && HEX.test(value) ? value : '#6366f1'} onChange={e => onChange(e.target.value)} className="size-9 rounded border border-border" />
      <input value={value ?? ''} onChange={e => onChange(e.target.value || null)} placeholder="#6366f1" className="w-24 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[12.5px]" />
    </div>
  )
}

function DomainBadge({ status }: { status: CustomDomainStatus | null }) {
  const cls = status === 'verified' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
    : status === 'failed' ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
    : 'bg-amber-50 text-amber-700 ring-amber-600/20'
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1', cls)}>{status ?? 'none'}</span>
}
