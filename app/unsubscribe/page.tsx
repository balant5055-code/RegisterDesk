// GET /unsubscribe?email=...&org=...&token=...
//
// Public server component — no auth required.
// Validates the HMAC token, adds email to the organizer's suppression list,
// and renders a confirmation (or error) page.
//
// The write is idempotent (fixed doc ID per email+org), so re-renders and
// duplicate link clicks are safe.

import type { Metadata } from 'next'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribeToken'
import { addToSuppressionList }   from '@/lib/firebase/firestore/emailSuppressionList'

export const metadata: Metadata = { title: 'Unsubscribe — RegisterDesk' }

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body style={{ margin: 0, fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif', background: '#f4f4f5' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
          <div style={{ width: '100%', maxWidth: 440, background: '#fff', borderRadius: 16, border: '1px solid #e5e7eb', padding: '40px 36px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 700, color: '#e5277e', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              RegisterDesk
            </div>
            {children}
          </div>
        </div>
      </body>
    </html>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface UnsubscribePageProps {
  searchParams: Promise<{ email?: string; org?: string; token?: string }>
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const { email, org, token } = await searchParams

  // ── Missing params ────────────────────────────────────────────────────────

  if (!email || !org || !token) {
    return (
      <Shell>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: '0 0 10px' }}>
          Invalid link
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6, margin: 0 }}>
          This unsubscribe link is missing required information. Please use the link
          from the original email.
        </p>
      </Shell>
    )
  }

  // ── Token validation ──────────────────────────────────────────────────────

  const valid = verifyUnsubscribeToken(email, org, token)

  if (!valid) {
    return (
      <Shell>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: '0 0 10px' }}>
          Link expired or invalid
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6, margin: 0 }}>
          This unsubscribe link could not be verified. Links are unique per email — please
          use the unsubscribe link from the specific email you received.
        </p>
      </Shell>
    )
  }

  // ── Write suppression record ──────────────────────────────────────────────
  // Idempotent: calling multiple times for the same email+org is a no-op after the first.

  let writeError = false
  try {
    await addToSuppressionList(email, org, 'unsubscribe_link')
  } catch {
    writeError = true
  }

  if (writeError) {
    return (
      <Shell>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: '0 0 10px' }}>
          Something went wrong
        </h1>
        <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6, margin: 0 }}>
          We were unable to process your request. Please try again or contact support.
        </p>
      </Shell>
    )
  }

  // ── Success ───────────────────────────────────────────────────────────────

  const displayEmail = decodeURIComponent(email)

  return (
    <Shell>
      {/* Checkmark icon */}
      <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#f0fdf4', border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: '0 0 10px' }}>
        You&apos;ve been unsubscribed
      </h1>

      <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6, margin: '0 0 6px' }}>
        <strong style={{ color: '#374151' }}>{displayEmail}</strong> will no longer receive
        broadcast emails from this organizer.
      </p>

      <p style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.6, margin: 0 }}>
        Transactional emails (ticket confirmations, refund notices) are unaffected.
      </p>
    </Shell>
  )
}
