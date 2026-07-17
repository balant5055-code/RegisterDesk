'use client'

import {
  Fragment, useCallback, useEffect, useRef, useState,
} from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  BROADCAST_AUDIENCE_LABELS,
  BROADCAST_STATUS_LABELS,
} from '@/lib/broadcasts/types'
import type { BroadcastAudience, BroadcastCampaign, BroadcastStatus } from '@/lib/broadcasts/types'
import { TEMPLATE_VARIABLES, SAMPLE_VARS, substituteVariables } from '@/lib/email-templates/types'
import { WHATSAPP_TEMPLATE_REGISTRY } from '@/lib/whatsapp/registry'
import type { WhatsAppTemplateType } from '@/lib/whatsapp/registry'
import { isOrganizerNotification } from '@/lib/notifications/catalog'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { PostBroadcastResponse, GetBroadcastsResponse } from '@/app/api/organizer/broadcasts/route'
import type { GetBroadcastStatsResponse, BroadcastWhatsAppStats } from '@/app/api/organizer/broadcasts/[campaignId]/stats/route'
import type { GetBroadcastJobResponse, SerializedBroadcastJob } from '@/app/api/organizer/broadcasts/[campaignId]/job/route'
import type { ProcessBroadcastJobResponse } from '@/app/api/organizer/broadcasts/[campaignId]/job/process/route'
import {
  Bold, Italic, Underline, Link2, List,
  ChevronDown, Loader2, Send, Mail, AlertCircle,
  CheckCircle2, Users, Eye, History, Plus, RefreshCw,
  FlaskConical, XCircle, CheckCheck, Clock, MessageCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { broadcastStatusCls } from '@/lib/ui/statusColors'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { EmptyState, PageHeader, buttonVariants } from '@/components/ui'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AUDIENCE_OPTIONS: { value: BroadcastAudience; label: string }[] = [
  { value: 'all',       label: 'All Registrations' },
  { value: 'confirmed', label: 'Confirmed Registrations' },
  { value: 'pending',   label: 'Pending Registrations' },
  { value: 'rejected',  label: 'Rejected Registrations' },
  { value: 'cancelled', label: 'Cancelled Registrations' },
]

// ─── WhatsApp template picker (WA-1) — reuses the shared template registry ─────

type BroadcastChannelUI = 'email' | 'whatsapp'
// Variables resolved per-recipient at send time (never entered by the organizer).
const WA_AUTO_VARS = new Set(['attendeeName', 'eventName', 'ticketCode'])
const WA_SAMPLE: Record<string, string> = {
  attendeeName: 'Asha Rao', eventName: 'Sample Event', ticketCode: 'TCK-1234',
  organizerName: 'Your Organisation', amount: '₹500', refundAmount: '₹500', tierName: 'Pro',
}
// Organizer broadcast composer offers ONLY organizer-scoped templates; platform
// lifecycle templates (wallet/licensing/settlement/event-review) stay hidden.
const WA_TEMPLATE_TYPES = (Object.keys(WHATSAPP_TEMPLATE_REGISTRY) as WhatsAppTemplateType[])
  .filter(t => isOrganizerNotification(t))
const humanizeTemplateType = (t: string) =>
  t.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

function buildPreviewHtml(subject: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject.replace(/</g, '&lt;')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px 8px}
  .shell{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .hdr{background:#e5277e;padding:18px 28px}
  .hdr span{font-size:11px;font-weight:700;color:#fff;letter-spacing:.14em;text-transform:uppercase;opacity:.9}
  .body{padding:28px 28px 24px;border:1px solid #e5e7eb;border-top:none}
  .ftr{background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:12px 28px;text-align:center}
  .ftr span{font-size:11.5px;color:#9ca3af}
</style>
</head><body>
<div class="shell">
  <div class="hdr"><span>RegisterDesk</span></div>
  <div class="body">${body}</div>
  <div class="ftr"><span>Powered by RegisterDesk</span></div>
</div></body></html>`
}

function wrapSelection(
  ta: HTMLTextAreaElement,
  before: string,
  after: string,
  onChange: (v: string) => void,
) {
  const { selectionStart: ss, selectionEnd: se, value } = ta
  const sel  = value.slice(ss, se)
  const repl = sel ? `${before}${sel}${after}` : `${before}placeholder${after}`
  const next = value.slice(0, ss) + repl + value.slice(se)
  onChange(next)
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ss, ss + repl.length) })
}

function insertAtCursor(ta: HTMLTextAreaElement, text: string, onChange: (v: string) => void) {
  const { selectionStart: ss, value } = ta
  const next = value.slice(0, ss) + text + value.slice(ss)
  onChange(next)
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ss + text.length, ss + text.length) })
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function CampaignStatusBadge({ status }: { status: BroadcastStatus }) {
  const ICONS: Record<BroadcastStatus, React.ElementType> = {
    draft:     Clock,
    scheduled: Clock,
    sending:   Clock,
    sent:      CheckCheck,
    partial:   CheckCircle2,
    failed:    XCircle,
    cancelled: XCircle,
  }
  const Icon = ICONS[status] ?? Clock
  const cls  = broadcastStatusCls[status] ?? 'bg-muted text-muted-foreground'
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold', cls)}>
      <Icon className="size-3" />
      {BROADCAST_STATUS_LABELS[status] ?? status}
    </span>
  )
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function FormattingToolbar({
  taRef,
  onChange,
}: {
  taRef:    React.RefObject<HTMLTextAreaElement | null>
  onChange: (v: string) => void
}) {
  const ta = () => taRef.current!
  const tb = (label: string, Icon: React.ElementType, action: () => void) => (
    <button
      key={label}
      type="button"
      title={label}
      onMouseDown={e => { e.preventDefault(); action() }}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      <Icon className="size-3.5" />
    </button>
  )
  // Handlers access taRef.current only when clicked (deferred), not during render.
  /* eslint-disable react-hooks/refs */
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/30 p-1">
      {tb('Bold',      Bold,      () => wrapSelection(ta(), '<strong>', '</strong>', onChange))}
      {tb('Italic',    Italic,    () => wrapSelection(ta(), '<em>', '</em>', onChange))}
      {tb('Underline', Underline, () => wrapSelection(ta(), '<u>', '</u>', onChange))}
      <div className="mx-1 h-4 w-px bg-border" />
      {tb('Link',      Link2,     () => wrapSelection(ta(), '<a href="URL">', '</a>', onChange))}
      {tb('List item', List,      () => wrapSelection(ta(), '<li>', '</li>', onChange))}
    </div>
  )
  /* eslint-enable react-hooks/refs */
}

// ─── Variable chips ───────────────────────────────────────────────────────────

function VariableChips({ onInsert }: { onInsert: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
      >
        Insert Variable <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TEMPLATE_VARIABLES.map(v => (
            <button
              key={v.key}
              type="button"
              title={v.description}
              onClick={() => { onInsert(v.name); setOpen(false) }}
              className="rounded-lg border border-border bg-muted/40 px-2 py-0.5 font-mono text-[12px] text-muted-foreground hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary transition-colors"
            >
              {v.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Confirmation dialog ──────────────────────────────────────────────────────

function ConfirmDialog({
  recipientCount,
  audienceLabel,
  eventName,
  onConfirm,
  onCancel,
  loading,
}: {
  recipientCount: number
  audienceLabel:  string
  eventName:      string
  onConfirm:      () => void
  onCancel:       () => void
  loading:        boolean
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>()
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" aria-hidden />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-campaign-title"
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl"
      >
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/[0.1] mb-4">
          <Send className="size-5 text-primary" />
        </div>
        <h2 id="send-campaign-title" className="text-[17px] font-bold text-foreground">Send Campaign?</h2>
        <p className="mt-2 text-[14px] text-muted-foreground leading-relaxed">
          This will send this broadcast to{' '}
          <strong className="text-foreground">{recipientCount.toLocaleString()} {recipientCount === 1 ? 'attendee' : 'attendees'}</strong>{' '}
          in <strong className="text-foreground">{audienceLabel}</strong> for{' '}
          <strong className="text-foreground">{eventName}</strong>.
        </p>
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {loading ? 'Sending…' : 'Send Campaign'}
          </button>
        </div>
      </div>
      </div>
    </>
  )
}

// ─── Compose tab ──────────────────────────────────────────────────────────────

function ComposeTab({
  events,
  eventsLoading,
  onSent,
}: {
  events:        EventListItem[]
  eventsLoading: boolean
  onSent:        (c: BroadcastCampaign) => void
}) {
  const [eventSlug,       setEventSlug]       = useState('')
  const [audience,        setAudience]        = useState<BroadcastAudience>('confirmed')
  const [channel,         setChannel]         = useState<BroadcastChannelUI>('email')
  const [subject,         setSubject]         = useState('')
  const [body,            setBody]            = useState('')
  const [waTemplate,      setWaTemplate]      = useState<WhatsAppTemplateType | ''>('')
  const [waLanguage,      setWaLanguage]      = useState('')
  const [waVars,          setWaVars]          = useState<Record<string, string>>({})
  const [previewTab,      setPreviewTab]      = useState<'edit' | 'preview'>('edit')

  const [countLoading,    setCountLoading]    = useState(false)
  const [recipientCount,  setRecipientCount]  = useState<number | null>(null)

  const [testLoading,     setTestLoading]     = useState(false)
  const [testMsg,         setTestMsg]         = useState<{ ok: boolean; msg: string } | null>(null)
  const [sendLoading,     setSendLoading]     = useState(false)
  const [sendError,       setSendError]       = useState<string | null>(null)
  const [showConfirm,     setShowConfirm]     = useState(false)
  const [scheduleFor,     setScheduleFor]     = useState('')   // datetime-local; empty = send now

  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const selectedEvent = events.find(e => e.slug === eventSlug)

  // WhatsApp template state derived from the shared registry.
  const waDef        = waTemplate ? WHATSAPP_TEMPLATE_REGISTRY[waTemplate] : null
  const waManualVars = waDef ? waDef.requiredVariables.filter(v => !WA_AUTO_VARS.has(v)) : []

  function selectWaTemplate(t: WhatsAppTemplateType | '') {
    setWaTemplate(t)
    setWaVars({})
    setWaLanguage(t ? WHATSAPP_TEMPLATE_REGISTRY[t].language : '')
  }

  // ── Fetch recipient count (channel-aware — WhatsApp counts phone recipients) ─
  const fetchCount = useCallback(async (slug: string, aud: BroadcastAudience, ch: BroadcastChannelUI) => {
    if (!slug) { setRecipientCount(null); return }
    setCountLoading(true)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const res  = await fetch('/api/organizer/broadcasts/count', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ eventSlug: slug, audience: aud, channel: ch }),
      })
      const data = await res.json() as { success: boolean; count?: number }
      if (data.success) setRecipientCount(data.count ?? 0)
    } catch { /* silent */ }
    finally { setCountLoading(false) }
  }, [])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- server-sync fetch when event/audience/channel changes */
    if (eventSlug) void fetchCount(eventSlug, audience, channel)
    else setRecipientCount(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [eventSlug, audience, channel, fetchCount])

  // ── Send test email ──────────────────────────────────────────────────────
  async function handleTest() {
    if (!subject.trim() || !body.trim()) {
      setTestMsg({ ok: false, msg: 'Subject and body required.' }); return
    }
    setTestLoading(true)
    setTestMsg(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const res  = await fetch('/api/organizer/broadcasts/test', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ subject: subject.trim(), html: body.trim() }),
      })
      const data = await res.json() as { success: boolean; error?: string }
      setTestMsg(data.success
        ? { ok: true,  msg: 'Test email sent to your account email.' }
        : { ok: false, msg: data.error ?? 'Test failed.' },
      )
    } catch {
      setTestMsg({ ok: false, msg: 'Network error.' })
    } finally {
      setTestLoading(false)
    }
  }

  // ── Send campaign ────────────────────────────────────────────────────────
  async function handleSend() {
    setSendLoading(true)
    setSendError(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setSendError('Not authenticated'); setSendLoading(false); return }
      const common = {
        eventId:   selectedEvent?.draftId ?? eventSlug,
        eventSlug,
        eventName: selectedEvent?.name ?? '',
        audience,
        // Future datetime ⇒ schedule; empty ⇒ send now.
        scheduledFor: scheduleFor ? new Date(scheduleFor).toISOString() : undefined,
      }
      const payload = channel === 'whatsapp'
        ? { ...common, channel: 'whatsapp', templateType: waTemplate, languageCode: waLanguage || undefined, variables: waVars }
        : { ...common, channel: 'email', subject: subject.trim(), html: body.trim() }
      const res  = await fetch('/api/organizer/broadcasts', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json() as PostBroadcastResponse
      if (!data.success) {
        setSendError(data.error ?? 'Send failed.')
        setSendLoading(false)
        setShowConfirm(false)
        return
      }
      onSent(data.campaign)
      // Reset form
      setEventSlug('')
      setAudience('confirmed')
      setSubject('')
      setBody('')
      selectWaTemplate('')
      setRecipientCount(null)
      setScheduleFor('')
    } catch {
      setSendError('Network error. Please try again.')
    } finally {
      setSendLoading(false)
      setShowConfirm(false)
    }
  }

  const emailReady   = !!subject.trim() && !!body.trim()
  const waReady      = !!waTemplate && waManualVars.every(v => (waVars[v] ?? '').trim().length > 0)
  const contentReady = channel === 'whatsapp' ? waReady : emailReady
  const canSend = !!eventSlug && contentReady && recipientCount !== null && recipientCount > 0

  // ── Preview ─────────────────────────────────────────────────────────────
  const previewSubject = substituteVariables(subject, SAMPLE_VARS)
  const previewBody    = substituteVariables(body,    SAMPLE_VARS, { escapeValues: true })
  const previewHtml    = buildPreviewHtml(previewSubject, previewBody)

  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          recipientCount={recipientCount ?? 0}
          audienceLabel={BROADCAST_AUDIENCE_LABELS[audience]}
          eventName={selectedEvent?.name ?? ''}
          onConfirm={() => void handleSend()}
          onCancel={() => setShowConfirm(false)}
          loading={sendLoading}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_420px]">

        {/* ── Left: compose form ── */}
        <div className="rounded-2xl border border-border bg-card">
          <div className="space-y-5 p-5">

            {/* Event selector */}
            <div className="space-y-1.5">
              <label htmlFor="bc-event" className="block text-[13px] font-semibold text-foreground">
                Event
              </label>
              {eventsLoading ? (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading events…
                </div>
              ) : (
                <select
                  id="bc-event"
                  value={eventSlug}
                  onChange={e => setEventSlug(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-[14px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Select an event…</option>
                  {events.filter(e => e.slug).map(e => (
                    <option key={e.draftId} value={e.slug!}>{e.name}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Channel selector */}
            <div className="space-y-1.5">
              <span className="block text-[13px] font-semibold text-foreground">Channel</span>
              <div className="flex gap-1 rounded-xl border border-border bg-muted/30 p-1">
                {([['email', 'Email', Mail], ['whatsapp', 'WhatsApp', MessageCircle]] as const).map(([val, label, Icon]) => (
                  <button
                    key={val} type="button" onClick={() => setChannel(val)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
                      channel === val ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Audience selector + count */}
            <div className="space-y-1.5">
              <label htmlFor="bc-audience" className="block text-[13px] font-semibold text-foreground">
                Audience
              </label>
              <div className="flex items-center gap-3">
                <select
                  id="bc-audience"
                  value={audience}
                  onChange={e => setAudience(e.target.value as BroadcastAudience)}
                  className="flex-1 rounded-xl border border-border bg-background px-3 py-2.5 text-[14px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  {AUDIENCE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>

                {/* Recipient count chip */}
                <div className={cn(
                  'shrink-0 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-semibold tabular-nums min-w-[90px]',
                  recipientCount === null
                    ? 'bg-muted text-muted-foreground'
                    : recipientCount === 0
                      ? 'bg-rose-100 text-rose-700'
                      : 'bg-emerald-100 text-emerald-700',
                )}>
                  {countLoading
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Users className="size-3.5" />
                  }
                  {countLoading
                    ? 'Loading…'
                    : recipientCount === null
                      ? 'Pick event'
                      : `${recipientCount.toLocaleString()} recipient${recipientCount !== 1 ? 's' : ''}`
                  }
                </div>
              </div>
            </div>

            {/* Email content (subject + HTML body) */}
            {channel === 'email' && (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="bc-subject" className="block text-[13px] font-semibold text-foreground">
                    Subject
                  </label>
                  <input
                    id="bc-subject"
                    type="text"
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    placeholder="Email subject line…"
                    className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="bc-body" className="block text-[13px] font-semibold text-foreground">
                      Message <span className="font-normal text-muted-foreground">(HTML)</span>
                    </label>
                    <FormattingToolbar taRef={taRef} onChange={v => setBody(v)} />
                  </div>
                  <textarea
                    id="bc-body"
                    ref={taRef}
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    rows={12}
                    spellCheck={false}
                    placeholder="Write your broadcast email here…"
                    className="w-full resize-y rounded-xl border border-border bg-background px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <VariableChips onInsert={v => {
                    if (taRef.current) insertAtCursor(taRef.current, v, val => setBody(val))
                    else setBody(prev => prev + v)
                  }} />
                </div>
              </>
            )}

            {/* WhatsApp content — approved Meta template only (no free-text HTML) */}
            {channel === 'whatsapp' && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="wa-template" className="block text-[13px] font-semibold text-foreground">Approved WhatsApp Template</label>
                  <select
                    id="wa-template" value={waTemplate}
                    onChange={e => selectWaTemplate(e.target.value as WhatsAppTemplateType | '')}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-[14px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">Select a template…</option>
                    {WA_TEMPLATE_TYPES.map(t => <option key={t} value={t}>{humanizeTemplateType(t)}</option>)}
                  </select>
                  <p className="text-[12px] text-muted-foreground">WhatsApp requires a pre-approved Meta template — free-text messages are not allowed.</p>
                </div>

                {waDef && (
                  <>
                    <div className="space-y-1.5">
                      <label htmlFor="wa-lang" className="block text-[13px] font-semibold text-foreground">Language</label>
                      <select
                        id="wa-lang" value={waLanguage} onChange={e => setWaLanguage(e.target.value)}
                        className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-[14px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        {waDef.languages.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <span className="block text-[13px] font-semibold text-foreground">Variables</span>
                      {waDef.requiredVariables.some(v => WA_AUTO_VARS.has(v)) && (
                        <p className="text-[12px] text-muted-foreground">
                          Auto-filled per attendee: {waDef.requiredVariables.filter(v => WA_AUTO_VARS.has(v)).join(', ')}.
                        </p>
                      )}
                      {waManualVars.length === 0 ? (
                        <p className="text-[12px] text-muted-foreground">No manual variables — every value is filled automatically.</p>
                      ) : waManualVars.map(v => (
                        <div key={v} className="space-y-1">
                          <label className="block font-mono text-[12px] font-medium text-muted-foreground">{`{{${v}}}`}</label>
                          <input
                            value={waVars[v] ?? ''}
                            onChange={e => setWaVars(prev => ({ ...prev, [v]: e.target.value }))}
                            placeholder={WA_SAMPLE[v] ?? `Value for ${v}`}
                            className="w-full rounded-xl border border-border bg-background px-3.5 py-2 text-[14px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                          />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

          </div>

          {/* Schedule + estimated cost */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-3">
            <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Clock className="size-3.5" aria-hidden />
              Schedule for
              <input
                type="datetime-local"
                value={scheduleFor}
                onChange={e => setScheduleFor(e.target.value)}
                className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-primary/30"
              />
              {scheduleFor && (
                <button type="button" onClick={() => setScheduleFor('')} className="text-[12px] font-medium text-muted-foreground hover:text-foreground underline">
                  clear
                </button>
              )}
            </label>
            <span className="ml-auto text-[12.5px] text-muted-foreground">
              Estimated cost: <strong className="text-foreground">
                {recipientCount
                  ? channel === 'whatsapp'
                    ? `${recipientCount.toLocaleString()} WhatsApp message${recipientCount !== 1 ? 's' : ''} (wallet)`
                    : 'Free (email)'
                  : '—'}
              </strong>
            </span>
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-border bg-muted/20 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* Feedback messages */}
              {testMsg && (
                <span className={cn(
                  'flex items-center gap-1.5 text-[13px] font-medium',
                  testMsg.ok ? 'text-emerald-600' : 'text-destructive',
                )}>
                  {testMsg.ok ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
                  {testMsg.msg}
                </span>
              )}
              {sendError && (
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-destructive">
                  <AlertCircle className="size-4" /> {sendError}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 ml-auto">
              {channel === 'email' && (
                <button
                  type="button"
                  onClick={() => void handleTest()}
                  disabled={testLoading || !subject.trim() || !body.trim()}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {testLoading ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                  Send Test
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowConfirm(true)}
                disabled={!canSend}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                <Send className="size-3.5" />
                {scheduleFor ? 'Schedule Send' : 'Send Now'}
                {recipientCount !== null && recipientCount > 0 && (
                  <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[11.5px]">
                    {recipientCount.toLocaleString()}
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* ── Right: preview ── */}
        <div className="flex flex-col gap-3">
          {channel === 'whatsapp' ? (
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/60">WhatsApp Preview — sample data</p>
                <p className="mt-0.5 truncate text-[13px] font-medium text-foreground">{waTemplate ? humanizeTemplateType(waTemplate) : 'Select a template'}</p>
              </div>
              <div className="bg-[#e5ddd5] p-4">
                {waDef ? (
                  <div className="max-w-[88%] rounded-lg rounded-tl-none bg-white px-3 py-2.5 shadow-sm">
                    <p className="text-[12px] font-semibold text-emerald-700">{waDef.templateName}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Language {waLanguage || waDef.language} · {waDef.category}</p>
                    <div className="mt-2 space-y-1">
                      {waDef.requiredVariables.map((v, i) => {
                        const val = WA_AUTO_VARS.has(v) ? (WA_SAMPLE[v] ?? v) : (waVars[v] || WA_SAMPLE[v] || `{{${v}}}`)
                        return (
                          <p key={v} className="text-[12.5px] text-foreground">
                            <span className="font-mono text-[11px] text-muted-foreground">{`{{${i + 1}}}`} {v}: </span>{val}
                          </p>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">Pick an approved template to preview it.</p>
                )}
              </div>
              <div className="border-t border-border px-4 py-3">
                <p className="text-[12px] text-muted-foreground">Attendee variables (name, event, ticket) are filled per recipient when the broadcast is sent.</p>
              </div>
            </div>
          ) : (
          <>
          <div className="flex gap-1 rounded-xl border border-border bg-muted/30 p-1 self-start">
            {(['edit', 'preview'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setPreviewTab(tab)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-all',
                  previewTab === tab ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab === 'preview' && <Eye className="size-3.5" />}
                {tab}
              </button>
            ))}
          </div>

          {previewTab === 'edit' ? (
            <div className="rounded-2xl border border-border bg-muted/20 p-5 space-y-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/60">
                Preview Tips
              </p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                Switch to Preview tab to see how your email will look with sample data.
                Variables like <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{'{{attendeeName}}'}</code> will be replaced
                with each attendee&apos;s real data when sending.
              </p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                Use <strong>Send Test</strong> to receive a preview at your account email before sending the campaign.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/60">
                  Preview — sample data
                </p>
                <p className="mt-0.5 text-[13px] font-medium text-foreground truncate">
                  {previewSubject || '(no subject)'}
                </p>
              </div>
              <div className="bg-[#f4f4f5]">
                <iframe
                  srcDoc={previewHtml}
                  title="Email preview"
                  className="h-[560px] w-full border-0"
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          )}
          </>
          )}
        </div>

      </div>
    </>
  )
}

// ─── WhatsApp live send progress (WA-3) ───────────────────────────────────────

const JOB_STATUS_TEXT: Record<string, string> = {
  pending: 'Queued', processing: 'Processing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
}

function BroadcastSendProgress({ campaignId, onDone }: { campaignId: string; onDone: () => void }) {
  const [job, setJob] = useState<SerializedBroadcastJob | null | 'loading'>('loading')
  const [err, setErr] = useState<string | null>(null)
  const running = useRef(false)

  const fetchJob = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch(`/api/organizer/broadcasts/${campaignId}/job`, { headers: { Authorization: `Bearer ${token}` } })
      const data  = await res.json() as GetBroadcastJobResponse
      if (data.success) setJob(data.job)
    } catch { /* keep last value */ }
  }, [campaignId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchJob() }, [fetchJob])

  // Poll while the job is still active.
  useEffect(() => {
    if (job === 'loading' || job === null) return
    if (job.status !== 'pending' && job.status !== 'processing') return
    const t = setInterval(() => { void fetchJob() }, 2500)
    return () => clearInterval(t)
  }, [job, fetchJob])

  async function resume() {
    if (running.current) return
    running.current = true
    setErr(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch(`/api/organizer/broadcasts/${campaignId}/job/process`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const data  = await res.json() as ProcessBroadcastJobResponse
      if (data.success && data.job) setJob(data.job)
      else if (!data.success) setErr(data.error)
    } catch { setErr('Resume failed') } finally { running.current = false }
  }

  async function cancel() {
    setErr(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      await fetch(`/api/organizer/broadcasts/${campaignId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      await fetchJob(); onDone()
    } catch { setErr('Cancel failed') }
  }

  if (job === 'loading') return <p className="text-[13px] text-muted-foreground">Loading progress…</p>
  if (job === null)      return <p className="text-[13px] text-muted-foreground">No WhatsApp send job for this campaign.</p>

  const total     = job.counts.total || 0
  const pct       = total ? Math.round((job.counts.processed / total) * 100) : 0
  const active    = job.status === 'pending' || job.status === 'processing'
  const remaining = Math.max(0, total - job.counts.processed)

  return (
    <div className="space-y-2 sm:max-w-md">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className="font-semibold text-foreground">{JOB_STATUS_TEXT[job.status] ?? job.status}</span>
        <span className="text-muted-foreground tabular-nums">Processed {job.counts.processed}/{total} ({pct}%)</span>
        <span className="text-emerald-600">✓ {job.counts.succeeded}</span>
        <span className="text-rose-600">✗ {job.counts.failed}</span>
        {active && <span className="text-muted-foreground">~{remaining} remaining</span>}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      {active && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void resume()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <RefreshCw className="size-3.5" /> Resume
          </button>
          <button type="button" onClick={() => void cancel()}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[12px] font-semibold text-rose-600 hover:bg-rose-50">
            <XCircle className="size-3.5" /> Cancel
          </button>
        </div>
      )}
      {err && <p className="text-[12px] text-rose-600">{err}</p>}
    </div>
  )
}

// ─── History tab ──────────────────────────────────────────────────────────────

function HistoryTab({
  campaigns,
  loading,
  error,
  onRefresh,
}: {
  campaigns: BroadcastCampaign[]
  loading:   boolean
  error:     string | null
  onRefresh: () => void
}) {
  // WA-2 — WhatsApp delivery breakdown, fetched on demand per campaign.
  const [openStats,  setOpenStats]  = useState<string | null>(null)
  const [statsCache, setStatsCache] = useState<Record<string, BroadcastWhatsAppStats | 'loading' | 'error'>>({})
  // WA-3 — live send-progress panel.
  const [openProgress, setOpenProgress] = useState<string | null>(null)

  async function toggleStats(id: string) {
    if (openStats === id) { setOpenStats(null); return }
    setOpenStats(id)
    if (statsCache[id] && statsCache[id] !== 'error') return
    setStatsCache(prev => ({ ...prev, [id]: 'loading' }))
    try {
      const token = await auth.currentUser?.getIdToken()
      const res   = await fetch(`/api/organizer/broadcasts/${id}/stats`, { headers: { Authorization: `Bearer ${token}` } })
      const data  = await res.json() as GetBroadcastStatsResponse
      setStatsCache(prev => ({ ...prev, [id]: data.success ? data.stats : 'error' }))
    } catch { setStatsCache(prev => ({ ...prev, [id]: 'error' })) }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 rounded-2xl border border-border bg-card py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-[14px] text-muted-foreground">Loading campaigns…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card py-16 text-center">
        <AlertCircle className="size-8 text-destructive/60" />
        <p className="text-[14px] text-destructive">{error}</p>
        <button onClick={onRefresh} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Try again
        </button>
      </div>
    )
  }

  if (campaigns.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card py-6">
        <EmptyState
          icon={Mail}
          title="No campaigns yet"
          description="Sent campaigns will appear here."
        />
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Subject', 'Event', 'Audience', 'Recipients', 'Status', 'Sent At'].map(h => (
                <th key={h} className="py-3 pl-4 pr-3 text-left text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {campaigns.map(c => (
              <Fragment key={c.id}>
              <tr className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                <td className="py-3 pl-4 pr-3">
                  <p className="max-w-[220px] truncate text-[13.5px] font-medium text-foreground" title={c.subject}>
                    {c.subject}
                  </p>
                </td>
                <td className="py-3 px-3">
                  <p className="max-w-[160px] truncate text-[13px] text-foreground">{c.eventName}</p>
                </td>
                <td className="py-3 px-3">
                  <p className="text-[13px] text-muted-foreground whitespace-nowrap">
                    {BROADCAST_AUDIENCE_LABELS[c.audience] ?? c.audience}
                  </p>
                </td>
                <td className="py-3 px-3">
                  <div>
                    <p className="tabular-nums text-[13.5px] font-semibold text-foreground">
                      {c.successCount.toLocaleString()}
                      <span className="ml-1 text-[12px] font-normal text-muted-foreground">
                        / {c.recipientCount.toLocaleString()}
                      </span>
                    </p>
                    {c.failCount > 0 && (
                      <p className="text-[12px] text-rose-600">{c.failCount} failed</p>
                    )}
                  </div>
                </td>
                <td className="py-3 px-3">
                  <CampaignStatusBadge status={c.status} />
                  {c.status === 'sending' ? (
                    <button
                      type="button" onClick={() => setOpenProgress(openProgress === c.id ? null : c.id)}
                      className="mt-1 flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline"
                    >
                      <MessageCircle className="size-3" /> {openProgress === c.id ? 'Hide' : 'Progress'}
                    </button>
                  ) : c.channel === 'whatsapp' ? (
                    <button
                      type="button" onClick={() => void toggleStats(c.id)}
                      className="mt-1 flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline"
                    >
                      <MessageCircle className="size-3" /> {openStats === c.id ? 'Hide' : 'Delivery'}
                    </button>
                  ) : null}
                </td>
                <td className="py-3 pl-3 pr-4">
                  <p className="whitespace-nowrap text-[12.5px] tabular-nums text-muted-foreground">
                    {c.status === 'scheduled' && c.scheduledFor
                      ? `for ${new Date(c.scheduledFor).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                      : c.sentAt
                        ? new Date(c.sentAt).toLocaleString('en-IN', {
                            day: '2-digit', month: 'short', year: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })
                        : '—'
                    }
                  </p>
                  <p className="whitespace-nowrap text-[11.5px] text-muted-foreground/70">
                    {c.actualCostPaise > 0 ? `₹${(c.actualCostPaise / 100).toLocaleString('en-IN')}` : 'Free'}
                  </p>
                </td>
              </tr>
              {openProgress === c.id && (
                <tr className="border-b border-border bg-muted/20">
                  <td colSpan={6} className="px-4 py-3">
                    <BroadcastSendProgress campaignId={c.id} onDone={onRefresh} />
                  </td>
                </tr>
              )}
              {c.channel === 'whatsapp' && openStats === c.id && (
                <tr className="border-b border-border bg-muted/20">
                  <td colSpan={6} className="px-4 py-3">
                    {(() => {
                      const s = statsCache[c.id]
                      if (s === 'loading' || s === undefined) return <p className="text-[13px] text-muted-foreground">Loading delivery…</p>
                      if (s === 'error') return <p className="text-[13px] text-destructive">Could not load delivery stats.</p>
                      const tiles: [string, number, string, string][] = [
                        ['Sent',      s.sent,      'text-foreground',    ''],
                        ['Delivered', s.delivered, 'text-emerald-600',   `${s.deliveryPct}%`],
                        ['Read',      s.read,      'text-blue-600',      `${s.readPct}%`],
                        ['Failed',    s.failed,    'text-rose-600',      `${s.failurePct}%`],
                      ]
                      return (
                        <div className="grid grid-cols-4 gap-2 sm:max-w-md">
                          {tiles.map(([label, count, cls, sub]) => (
                            <div key={label} className="rounded-lg border border-border bg-card px-2.5 py-2 text-center">
                              <p className={`text-[17px] font-bold ${cls}`}>{count}</p>
                              <p className="text-[11px] font-medium text-muted-foreground">{label}{sub && <span className="ml-1 text-muted-foreground/70">{sub}</span>}</p>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-4 py-3">
        <p className="text-[12.5px] text-muted-foreground">
          {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
        </p>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BroadcastsClient() {
  const [tab,       setTab]       = useState<'compose' | 'history'>('compose')
  const [events,    setEvents]    = useState<EventListItem[]>([])
  const [evLoading, setEvLoading] = useState(true)
  const [campaigns, setCampaigns] = useState<BroadcastCampaign[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [histError,   setHistError]   = useState<string | null>(null)
  const [sentBanner,  setSentBanner]  = useState<BroadcastCampaign | null>(null)

  // ── Load events ────────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!token) return
        const res  = await fetch('/api/organizer/events', { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json() as { events?: EventListItem[] }
        setEvents((data.events ?? []).filter(e => e.status === 'published' && e.slug))
      } catch { /* silent */ }
      finally { setEvLoading(false) }
    })()
  }, [])

  // ── Load campaign history ─────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistLoading(true)
    setHistError(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const res  = await fetch('/api/organizer/broadcasts', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json() as GetBroadcastsResponse
      if (data.success) setCampaigns(data.campaigns)
      else setHistError(data.error)
    } catch {
      setHistError('Failed to load campaign history.')
    } finally {
      setHistLoading(false)
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async history load
  useEffect(() => { void loadHistory() }, [loadHistory])

  function handleSent(c: BroadcastCampaign) {
    setSentBanner(c)
    setCampaigns(prev => [c, ...prev])
    setTab('history')
    setTimeout(() => setSentBanner(null), 6000)
  }

  return (
    <div className="space-y-6">

      {/* ── Page header ── */}
      <PageHeader
        title="Broadcasts"
        subtitle="Send email campaigns to your event attendees."
        breadcrumb={[
          { label: 'Communications', href: '/dashboard/communications' },
          { label: 'Broadcasts' },
        ]}
      />

      {/* ── Success banner ── */}
      {sentBanner && (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
          <div>
            <p className="text-[14px] font-semibold text-emerald-900">Campaign sent!</p>
            <p className="mt-0.5 text-[13px] text-emerald-700">
              <strong>{sentBanner.successCount.toLocaleString()}</strong> of{' '}
              <strong>{sentBanner.recipientCount.toLocaleString()}</strong> emails delivered for{' '}
              &ldquo;{sentBanner.subject}&rdquo;
              {sentBanner.failCount > 0 && ` · ${sentBanner.failCount} failed`}.
            </p>
          </div>
        </div>
      )}

      {/* ── Tab switcher ── */}
      <div className="flex gap-1 rounded-xl border border-border bg-muted/30 p-1 self-start">
        <button
          type="button"
          onClick={() => setTab('compose')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-4 py-2 text-[13.5px] font-medium transition-all',
            tab === 'compose' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Plus className="size-3.5" /> New Broadcast
        </button>
        <button
          type="button"
          onClick={() => { setTab('history'); void loadHistory() }}
          className={cn(
            'flex items-center gap-2 rounded-lg px-4 py-2 text-[13.5px] font-medium transition-all',
            tab === 'history' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <History className="size-3.5" /> Campaign History
          {campaigns.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {campaigns.length}
            </span>
          )}
        </button>
        {tab === 'history' && (
          <button
            type="button"
            onClick={() => void loadHistory()}
            title="Refresh"
            className="ml-1 flex items-center justify-center rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}
      </div>

      {/* ── Tab content ── */}
      {tab === 'compose' && (
        <ComposeTab
          events={events}
          eventsLoading={evLoading}
          onSent={handleSent}
        />
      )}
      {tab === 'history' && (
        <HistoryTab
          campaigns={campaigns}
          loading={histLoading}
          error={histError}
          onRefresh={() => void loadHistory()}
        />
      )}

    </div>
  )
}
