'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  KeyRound, Webhook, Loader2, Plus, Trash2, Copy, Check, AlertCircle, Send, RefreshCw,
} from 'lucide-react'
import {
  API_KEY_PERMISSIONS, type ApiKeyView, type ApiKeyPermission,
  type WebhookConfig, type WebhookDeliveryView,
} from '@/lib/integrations/types'

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default function IntegrationsPage() {
  const userRef = useRef<User | null>(null)
  const [keys,    setKeys]    = useState<ApiKeyView[]>([])
  const [config,  setConfig]  = useState<WebhookConfig>({ webhookUrl: null, webhookSecret: null })
  const [deliveries, setDeliveries] = useState<WebhookDeliveryView[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const u = userRef.current
    if (!u) throw new Error('Not signed in.')
    const token = await u.getIdToken()
    return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
  }, [])

  const reload = useCallback(async () => {
    try {
      const [kRes, wRes] = await Promise.all([
        authedFetch('/api/organizer/api-keys'),
        authedFetch('/api/organizer/webhooks'),
      ])
      if (kRes.ok) setKeys(((await kRes.json()) as { keys: ApiKeyView[] }).keys)
      if (wRes.ok) {
        const w = await wRes.json() as { config: WebhookConfig; deliveries: WebhookDeliveryView[] }
        setConfig(w.config); setDeliveries(w.deliveries)
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally { setLoading(false) }
  }, [authedFetch])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      userRef.current = user
      if (!user) { setError('You must be signed in.'); setLoading(false); return }
      void reload()
    })
    return unsub
  }, [reload])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div>
        <h1 className="text-[20px] font-bold tracking-tight text-foreground">Integrations</h1>
        <p className="text-[13.5px] text-muted-foreground">API keys and webhooks for connecting RegisterDesk to your systems.</p>
      </div>
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error}</div>}

      <ApiKeysSection keys={keys} authedFetch={authedFetch} onChange={reload} />
      <WebhooksSection config={config} deliveries={deliveries} authedFetch={authedFetch} onChange={reload} />
    </div>
  )
}

// ─── API keys ─────────────────────────────────────────────────────────────────

function ApiKeysSection({ keys, authedFetch, onChange }: {
  keys: ApiKeyView[]; authedFetch: (p: string, i?: RequestInit) => Promise<Response>; onChange: () => Promise<void>
}) {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const [creating, setCreating] = useState(false)
  const [name,     setName]     = useState('')
  const [perms,    setPerms]    = useState<ApiKeyPermission[]>(['registrations.read'])
  const [busy,     setBusy]     = useState(false)
  const [newKey,   setNewKey]   = useState<string | null>(null)
  const [copied,   setCopied]   = useState(false)

  async function create() {
    if (!name.trim() || perms.length === 0) return
    setBusy(true)
    try {
      const res = await authedFetch('/api/organizer/api-keys', { method: 'POST', body: JSON.stringify({ name: name.trim(), permissions: perms }) })
      const data = await res.json().catch(() => null) as { plaintextKey?: string; error?: string } | null
      if (!res.ok || !data?.plaintextKey) throw new Error(data?.error ?? 'Could not create key.')
      setNewKey(data.plaintextKey); setName(''); setPerms(['registrations.read']); setCreating(false)
      await onChange()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') } finally { setBusy(false) }
  }
  async function revoke(keyId: string) {
    if (!(await confirm({ message: 'Revoke this API key? Requests using it will immediately stop working.', tone: 'danger' }))) return
    const res = await authedFetch(`/api/organizer/api-keys/${keyId}`, { method: 'DELETE' })
    if (res.ok) await onChange()
  }

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2"><KeyRound className="size-4 text-primary" aria-hidden /><h2 className="text-[15px] font-bold text-foreground">API Keys</h2></div>
        <button onClick={() => setCreating(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted"><Plus className="size-3.5" /> New key</button>
      </div>

      {newKey && (
        <div className="m-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-[13px] font-semibold text-emerald-800">Copy your key now — it won&apos;t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-background px-3 py-2 font-mono text-[12.5px]">{newKey}</code>
            <button onClick={() => { navigator.clipboard.writeText(newKey); setCopied(true); setTimeout(() => setCopied(false), 1500) }} className="rounded-lg border border-border px-2.5 py-2 hover:bg-muted">{copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}</button>
          </div>
          <button onClick={() => setNewKey(null)} className="mt-2 text-[12px] font-medium text-emerald-700 underline">Done</button>
        </div>
      )}

      {creating && (
        <div className="m-5 rounded-xl border border-border bg-muted/20 p-4">
          <label className="block"><span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Zapier integration" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px]" /></label>
          <div className="mt-3"><span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Permissions</span>
            <div className="grid grid-cols-2 gap-1.5">
              {API_KEY_PERMISSIONS.map(p => (
                <label key={p} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={perms.includes(p)} onChange={e => setPerms(prev => e.target.checked ? [...prev, p] : prev.filter(x => x !== p))} /> {p}
                </label>
              ))}
            </div>
          </div>
          <button onClick={() => void create()} disabled={busy || !name.trim() || perms.length === 0} className="mt-3 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>{busy && <Loader2 className="size-4 animate-spin" />} Create key</button>
        </div>
      )}

      <div className="px-5 py-4">
        {keys.length === 0 ? <p className="text-[13.5px] text-muted-foreground">No API keys yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-[13.5px]">
            <thead><tr className="border-b border-border text-left text-[12px] font-semibold text-muted-foreground">
              <th className="px-2 py-2">Name</th><th className="px-2 py-2">Prefix</th><th className="px-2 py-2">Created</th><th className="px-2 py-2">Last Used</th><th className="px-2 py-2">Status</th><th className="px-2 py-2 text-right">Action</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {keys.map(k => (
                <tr key={k.keyId}>
                  <td className="px-2 py-2.5 font-medium text-foreground">{k.name}</td>
                  <td className="px-2 py-2.5 font-mono text-[12px] text-muted-foreground">{k.keyPrefix}…</td>
                  <td className="px-2 py-2.5 text-muted-foreground">{fmt(k.createdAt)}</td>
                  <td className="px-2 py-2.5 text-muted-foreground">{fmt(k.lastUsedAt)}</td>
                  <td className="px-2 py-2.5"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', k.status === 'active' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-rose-50 text-rose-700 ring-rose-600/20')}>{k.status}</span></td>
                  <td className="px-2 py-2.5 text-right">{k.status === 'active' && <button onClick={() => void revoke(k.keyId)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-muted"><Trash2 className="size-3.5" /> Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </section>
  )
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

function WebhooksSection({ config, deliveries, authedFetch, onChange }: {
  config: WebhookConfig; deliveries: WebhookDeliveryView[]
  authedFetch: (p: string, i?: RequestInit) => Promise<Response>; onChange: () => Promise<void>
}) {
  const { showToast } = useToast()
  const [url,  setUrl]  = useState(config.webhookUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [revealSecret, setRevealSecret] = useState(false)

  async function save(rotateSecret = false) {
    setBusy(true); setTestMsg(null)
    try {
      const res = await authedFetch('/api/organizer/webhooks', { method: 'PUT', body: JSON.stringify({ webhookUrl: url || null, rotateSecret }) })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? 'Save failed.')
      await onChange()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') } finally { setBusy(false) }
  }
  async function test() {
    setBusy(true); setTestMsg(null)
    try {
      const res = await authedFetch('/api/organizer/webhooks/test', { method: 'POST' })
      const data = await res.json().catch(() => null) as { delivered?: boolean; responseCode?: number; error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? 'Test failed.')
      setTestMsg(data?.delivered ? `Delivered (HTTP ${data.responseCode}).` : `Not delivered (HTTP ${data?.responseCode ?? '—'}). Check your endpoint.`)
      await onChange()
    } catch (e) { setTestMsg(e instanceof Error ? e.message : 'Test failed') } finally { setBusy(false) }
  }

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-5 py-4"><Webhook className="size-4 text-primary" aria-hidden /><h2 className="text-[15px] font-bold text-foreground">Webhooks</h2></div>
      <div className="space-y-4 px-5 py-5">
        <label className="block"><span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Endpoint URL (https)</span>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/webhooks/registerdesk" className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[13.5px] font-mono" /></label>

        {config.webhookSecret && (
          <div><span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Signing secret (X-RegisterDesk-Signature = HMAC-SHA256)</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-[12px]">{revealSecret ? config.webhookSecret : '•'.repeat(24)}</code>
              <button onClick={() => setRevealSecret(v => !v)} className="rounded-lg border border-border px-2.5 py-2 text-[12px] hover:bg-muted">{revealSecret ? 'Hide' : 'Reveal'}</button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button onClick={() => void save(false)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[13.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>{busy && <Loader2 className="size-4 animate-spin" />} Save</button>
          <button onClick={() => void save(true)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted"><RefreshCw className="size-3.5" /> Rotate secret</button>
          <button onClick={() => void test()} disabled={busy || !config.webhookUrl} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-50"><Send className="size-3.5" /> Test webhook</button>
        </div>
        {testMsg && <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><AlertCircle className="size-4" /> {testMsg}</p>}

        {/* Delivery history */}
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Recent deliveries</p>
          {deliveries.length === 0 ? <p className="text-[13px] text-muted-foreground">No deliveries yet.</p> : (
            <div className="overflow-x-auto rounded-xl border border-border"><table className="w-full min-w-[560px] text-[13px]">
              <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                <th className="px-3 py-2">Event</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Attempts</th><th className="px-3 py-2">Response</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {deliveries.map(d => (
                  <tr key={d.deliveryId}>
                    <td className="px-3 py-2 font-mono text-[12px]">{d.eventType}</td>
                    <td className="px-3 py-2"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1', d.status === 'delivered' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : d.status === 'failed' ? 'bg-rose-50 text-rose-700 ring-rose-600/20' : 'bg-amber-50 text-amber-700 ring-amber-600/20')}>{d.status}</span></td>
                    <td className="px-3 py-2 text-muted-foreground">{d.attempts}</td>
                    <td className="px-3 py-2 text-muted-foreground">{d.responseCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
    </section>
  )
}
