'use client'

// Phase P1.1 — Global route error boundary. Catches uncaught errors in any route
// segment under the root layout, shows a branded recoverable screen, and offers a
// retry. Errors are logged to the console (no PII assumptions).

import { useEffect } from 'react'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'

export default function GlobalRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Safe logging — message + digest only.
    console.error('[app/error]', error.message, error.digest ?? '')
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center bg-background px-6 py-16 text-center">
      <div className="mx-auto max-w-md">
        <h1 className="text-[var(--fs-2xl)] font-bold tracking-tight text-foreground sm:text-[var(--fs-3xl)]">
          Something went wrong
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          {error.message || 'An unexpected error occurred. Please try again, or head back home.'}
        </p>
        {error.digest && (
          <p className="mt-2 text-[12px] text-muted-foreground/60">Reference: {error.digest}</p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button type="button" onClick={reset} className={buttonVariants({ variant: 'primary', size: 'md' })}>
            <RefreshCw className="size-4" aria-hidden /> Try again
          </button>
          <Link href="/" className={buttonVariants({ variant: 'outline', size: 'md' })}>
            Go home
          </Link>
        </div>
      </div>
    </div>
  )
}
