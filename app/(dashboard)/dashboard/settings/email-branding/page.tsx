'use client'

// RD-PRODUCT-01C — organizer email white-label settings + live preview.
// Reuses the pure emailShell (client-safe) to render an accurate, instant preview
// across light/dark × desktop/mobile. Save persists via /api/organizer/email-branding;
// "Send test" delivers a branded sample to the organizer.

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, Monitor, Smartphone, Send, Check } from 'lucide-react'
import { emailShell, btn, metaRow, type EmailBranding } from '@/lib/email/templates/base'

interface Form {
  enabled: boolean; companyName: string; logoUrl: string; primaryColor: string; secondaryColor: string
  website: string; supportEmail: string; supportPhone: string; footerText: string; copyright: string
  hideRegisterDeskBranding: boolean
}
const EMPTY: Form = {
  enabled: true, companyName: '', logoUrl: '', primaryColor: '', secondaryColor: '',
  website: '', supportEmail: '', supportPhone: '', footerText: '', copyright: '', hideRegisterDeskBranding: false,
}

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

function toBranding(f: Form): EmailBranding | undefined {
  if (!f.enabled) return undefined
  return {
    companyName: f.companyName || null, logoUrl: f.logoUrl || null,
    primaryColor: f.primaryColor || null, secondaryColor: f.secondaryColor || null,
    website: f.website || null, supportEmail: f.supportEmail || null, supportPhone: f.supportPhone || null,
    footerText: f.footerText || null, copyright: f.copyright || null,
    hideRegisterDeskBranding: f.hideRegisterDeskBranding,
  }
}

function previewHtml(f: Form): string {
  const body = `
    <p style="font-size:15px;color:#111827;margin:0 0 6px;">Hi Priya,</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 18px;">
      Your registration for <strong>Annual Tech Summit 2026</strong> is confirmed. Your ticket is below.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 18px;">
      ${metaRow('Ticket', 'RD-8F3K2M9Q')}${metaRow('Pass', 'Full Conference')}
      ${metaRow('Date', 'Saturday, 14 March 2026')}${metaRow('Venue', 'Bengaluru International Centre')}
    </table>
    ${btn('Download Ticket', '#')}${btn('View Details', '#', false)}
  `
  return emailShell('Registration confirmed', body, undefined, toBranding(f))
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-[12px] font-medium text-foreground">{label}</span>
    {children}
  </label>
)
const input = 'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground'

export default function EmailBrandingPage() {
  const [form, setForm]   = useState<Form>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [savedAt, setSavedAt] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [device, setDevice]   = useState<'desktop' | 'mobile'>('desktop')
  const [dark, setDark]       = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const token = await getToken()
      const res = await fetch('/api/organizer/email-branding', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (res.ok) { const { branding } = await res.json() as { branding: Partial<Form> }; setForm({ ...EMPTY, ...branding }) }
    })().catch(e => setError(e instanceof Error ? e.message : 'Failed to load')).finally(() => setLoading(false))
  }, [])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm(f => ({ ...f, [k]: v })); setSavedAt(false) }

  const save = useCallback(async () => {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/organizer/email-branding', {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(form),
      })
      if (!res.ok) { const e = await res.json() as { error?: string; details?: string[] }; throw new Error(e.details?.join('; ') || e.error || 'Save failed') }
      setSavedAt(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') } finally { setSaving(false) }
  }, [form])

  const sendTest = useCallback(async () => {
    setTestMsg(null); setError(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/organizer/email-branding', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: auth.currentUser?.email }),
      })
      const j = await res.json() as { ok?: boolean; sentTo?: string; error?: string }
      if (!res.ok || !j.ok) throw new Error(j.error || 'Send failed')
      setTestMsg(`Sent to ${j.sentTo}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Send failed') }
  }, [])

  if (loading) return <div className="flex items-center gap-2 p-8 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Email Branding</h1>
        <p className="text-[13px] text-muted-foreground">White-label every attendee email with your organization&rsquo;s identity. Changes apply after saving.</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        {/* ── Form ── */}
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <label className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
            Enable white-label branding
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Organization name"><input className={input} value={form.companyName} onChange={e => set('companyName', e.target.value)} placeholder="Acme Events" /></Field>
            <Field label="Logo URL"><input className={input} value={form.logoUrl} onChange={e => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" /></Field>
            <Field label="Primary colour"><input className={input} value={form.primaryColor} onChange={e => set('primaryColor', e.target.value)} placeholder="#e5277e" /></Field>
            <Field label="Secondary colour"><input className={input} value={form.secondaryColor} onChange={e => set('secondaryColor', e.target.value)} placeholder="#6b7280" /></Field>
            <Field label="Website"><input className={input} value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://acme.events" /></Field>
            <Field label="Support email"><input className={input} value={form.supportEmail} onChange={e => set('supportEmail', e.target.value)} placeholder="help@acme.events" /></Field>
            <Field label="Support phone"><input className={input} value={form.supportPhone} onChange={e => set('supportPhone', e.target.value)} placeholder="+91 …" /></Field>
            <Field label="Copyright"><input className={input} value={form.copyright} onChange={e => set('copyright', e.target.value)} placeholder="© 2026 Acme Events" /></Field>
          </div>
          <Field label="Footer text"><input className={input} value={form.footerText} onChange={e => set('footerText', e.target.value)} placeholder="Thanks for being part of our community." /></Field>
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={form.hideRegisterDeskBranding} onChange={e => set('hideRegisterDeskBranding', e.target.checked)} />
            Hide &ldquo;Powered by RegisterDesk&rdquo;
          </label>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : savedAt ? <Check className="h-3.5 w-3.5" /> : null}{savedAt ? 'Saved' : 'Save'}
            </button>
            <button onClick={sendTest} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] text-foreground hover:bg-muted">
              <Send className="h-3.5 w-3.5" /> Send test email
            </button>
            {testMsg && <span className="text-[12px] text-emerald-600">{testMsg}</span>}
          </div>
          <p className="text-[11px] text-muted-foreground">Test emails use your last saved branding. Save first to test changes.</p>
        </div>

        {/* ── Live preview ── */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setDevice('desktop')} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] ${device === 'desktop' ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}><Monitor className="h-3.5 w-3.5" /> Desktop</button>
            <button onClick={() => setDevice('mobile')} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] ${device === 'mobile' ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}><Smartphone className="h-3.5 w-3.5" /> Mobile</button>
            <button onClick={() => setDark(d => !d)} className={`ml-auto rounded-md border px-2 py-1 text-[12px] ${dark ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>{dark ? 'Dark' : 'Light'}</button>
          </div>
          <div className="overflow-hidden rounded-xl border border-border" style={{ background: dark ? '#111827' : '#f4f4f5' }}>
            <iframe
              title="Email preview"
              srcDoc={previewHtml(form)}
              className="mx-auto block h-[520px] w-full border-0"
              style={{ maxWidth: device === 'mobile' ? 390 : '100%' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
