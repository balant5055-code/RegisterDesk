'use client'

// Phase P1.1 — Root error boundary. Replaces the root layout when the layout
// itself throws, so it must render its own <html>/<body>. Self-contained styles
// (brand pink) — it cannot rely on app providers or the design-system components
// because the layout that mounts them has failed.

import { useEffect } from 'react'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app/global-error]', error.message, error.digest ?? '')
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f5f5f5', color: '#111' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{ maxWidth: '420px', textAlign: 'center' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 12px' }}>Something went wrong</h1>
            <p style={{ fontSize: '15px', lineHeight: 1.6, color: '#555', margin: '0 0 20px' }}>
              {error.message || 'A critical error occurred while loading the application. Please try again.'}
            </p>
            {error.digest && (
              <p style={{ fontSize: '12px', color: '#999', margin: '0 0 20px' }}>Reference: {error.digest}</p>
            )}
            <button
              type="button"
              onClick={reset}
              style={{ background: '#e5277e', color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
