// GET /unsubscribe?t=…            (sealed v2 link)
// GET /unsubscribe?email=…&org=…&token=…   (legacy v1 link, still honoured)
//
// Public server component — no login: the signed link is the credential.
//
// RD-COMMS-P2-G — opening the page CHANGES NOTHING. It verifies the link, says exactly what the
// recipient is opting out of (this organizer's announcement and reminder emails — never tickets,
// receipts or refunds) and asks them to confirm with a button that POSTs to /api/unsubscribe. A
// link scanner or prefetch therefore cannot unsubscribe anyone, an edited or expired link fails
// safely, and a recipient who has opted out can opt back in from the same link. The outcome comes
// back as `?state=`, which only selects wording — the actual state is re-read from the server.

import type { Metadata } from 'next'
import { adminDb } from '@/lib/firebase/admin'
import { parseUnsubscribeParams } from '@/lib/email/unsubscribeToken'
import { suppressionStatus } from '@/lib/firebase/firestore/emailSuppressionList'
import { loadOrganizerEmailBranding } from '@/lib/email/branding'

// noindex: a one-off transactional page reached from a signed link in an email. It was
// indexable and, having no description of its own, inherited the root layout's — so it
// shared a meta description with two unrelated routes. robots.txt already disallows the
// path; this closes the other door, where a crawler follows a shared link directly.
export const metadata: Metadata = {
  title:  'Unsubscribe — RegisterDesk',
  robots: { index: false, follow: false },
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

const H1 = { fontSize: 20, fontWeight: 700, color: '#111827', margin: '0 0 10px' } as const
const P  = { fontSize: 14, color: '#6b7280', lineHeight: 1.6, margin: '0 0 10px' } as const
const NOTE = { fontSize: 13, color: '#9ca3af', lineHeight: 1.6, margin: 0 } as const
const BTN = {
  display: 'inline-block', marginTop: 14, padding: '10px 18px', borderRadius: 10, border: '1px solid #d1d5db',
  background: '#111827', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
} as const
const BTN_GHOST = { ...BTN, background: '#fff', color: '#111827' } as const

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body style={{ margin: 0, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif', background: '#f4f4f5' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', boxSizing: 'border-box' }}>
          <div style={{ width: '100%', maxWidth: 440, boxSizing: 'border-box', background: '#fff', borderRadius: 16, border: '1px solid #e5e7eb', padding: '36px 28px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflowWrap: 'anywhere' }}>
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 700, color: 'var(--action)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              RegisterDesk
            </div>
            {children}
          </div>
        </main>
      </body>
    </html>
  )
}

/** The form posts the SAME signed parameters back — the server re-verifies them. */
function ActionForm({ params, action, label, ghost }: { params: Record<string, string>; action: 'unsubscribe' | 'resubscribe'; label: string; ghost?: boolean }) {
  return (
    <form method="post" action="/api/unsubscribe" style={{ margin: 0 }}>
      {Object.entries(params).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="action" value={action} />
      <button type="submit" style={ghost ? BTN_GHOST : BTN}>{label}</button>
    </form>
  )
}

/** r•••@example.com — enough for the recipient to recognise, not enough to harvest a forwarded link. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '•••'
  return `${local.slice(0, 1)}•••@${domain}`
}

async function names(organizerUid: string, eventSlug: string | null): Promise<{ organizer: string; event: string | null }> {
  const [branding, user, ev] = await Promise.all([
    loadOrganizerEmailBranding(organizerUid).catch(() => null),
    adminDb.doc(`users/${organizerUid}`).get().catch(() => null),
    eventSlug ? adminDb.doc(`events/${eventSlug}`).get().catch(() => null) : Promise.resolve(null),
  ])
  const u = user?.exists ? user.data() as Record<string, unknown> : {}
  const organizer = (branding?.companyName?.trim()) || (typeof u.organizationName === 'string' && u.organizationName.trim()) || 'this event organizer'
  // Only name an event that belongs to this organizer.
  const e = ev?.exists ? ev.data() as Record<string, unknown> : null
  const info = (e?.eventDetails as { info?: { name?: unknown } } | undefined)?.info
  const event = e && e.uid === organizerUid && typeof info?.name === 'string' ? info.name : null
  return { organizer, event }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface UnsubscribePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const sp = await searchParams
  const one = (k: string) => (typeof sp[k] === 'string' ? sp[k] as string : null)
  const parsed = parseUnsubscribeParams({ get: one })

  if (!parsed.ok) {
    return (
      <Shell>
        <h1 style={H1}>{parsed.reason === 'expired' ? 'This link has expired' : 'Invalid link'}</h1>
        <p style={{ ...P, margin: 0 }}>
          {parsed.reason === 'expired'
            ? 'This unsubscribe link is too old to use. Please use the unsubscribe link in a more recent email from the organizer.'
            : 'This unsubscribe link could not be verified. Please use the link exactly as it appears in the email you received.'}
        </p>
      </Shell>
    )
  }

  const { email, organizerUid, eventSlug } = parsed.target
  // Echo back ONLY the signed parameters.
  const signed: Record<string, string> = {}
  for (const k of ['t', 'email', 'org', 'token']) { const v = one(k); if (v) signed[k] = v }

  let status: { platform: boolean; organizer: boolean }
  try { status = await suppressionStatus(email, organizerUid) }
  catch {
    return (<Shell><h1 style={H1}>Something went wrong</h1><p style={{ ...P, margin: 0 }}>We could not check your preferences. Please try again in a moment.</p></Shell>)
  }
  const { organizer, event } = await names(organizerUid, eventSlug)
  const state = one('state')
  const who = <strong style={{ color: '#374151' }}>{maskEmail(email)}</strong>
  const what = <>announcement and reminder emails from <strong style={{ color: '#374151' }}>{organizer}</strong>{event ? <> (for example, about <strong style={{ color: '#374151' }}>{event}</strong>)</> : null}</>
  const transactional = (
    <p style={NOTE}>Tickets, registration and payment confirmations, refunds and other essential messages about your registrations are not affected.</p>
  )

  if (state === 'error') {
    return (<Shell><h1 style={H1}>Something went wrong</h1><p style={P}>Your request could not be completed. Please try again.</p><ActionForm params={signed} action="unsubscribe" label="Try again" /></Shell>)
  }
  if (state === 'cannot_resubscribe') {
    return (<Shell><h1 style={H1}>We can’t turn these emails back on</h1><p style={P}>Emails to {who} from {organizer} stopped because earlier messages could not be delivered or were reported. Contact the organizer if this is a mistake.</p>{transactional}</Shell>)
  }

  if (status.organizer) {
    return (
      <Shell>
        <h1 style={H1}>{state === 'unsubscribed' ? 'You’ve been unsubscribed' : 'You’re unsubscribed'}</h1>
        <p style={P}>{who} will no longer receive {what}.</p>
        {transactional}
        <p style={{ ...NOTE, marginTop: 14 }}>Changed your mind?</p>
        <ActionForm params={signed} action="resubscribe" label="Resubscribe" ghost />
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 style={H1}>{state === 'resubscribed' ? 'You’re subscribed again' : 'Unsubscribe from these emails?'}</h1>
      <p style={P}>
        {state === 'resubscribed'
          ? <>{who} will receive {what} again.</>
          : <>Stop sending {what} to {who}.</>}
      </p>
      {transactional}
      {status.platform && (
        <p style={{ ...NOTE, marginTop: 10 }}>Note: email to this address is currently paused for every sender because earlier messages could not be delivered.</p>
      )}
      {state !== 'resubscribed' && <ActionForm params={signed} action="unsubscribe" label="Unsubscribe" />}
    </Shell>
  )
}
