import Link from 'next/link'
import { Compass } from 'lucide-react'
import { HomeShell }      from '@/components/discovery/home/HomeShell'
import { Container }      from '@/components/ui/Container'
import { marketingButton } from '@/lib/marketing/theme'

// ─── The root 404 ────────────────────────────────────────────────────────────
//
// GA-7D S2 made this a branded page (it was Next.js's unstyled default). It was written
// self-contained — no chrome at all — so that it would "render correctly in any context".
//
// It now carries the CANONICAL public chrome. A 404 is a public surface by definition:
// whoever lands here followed a link that no longer resolves, and the useful thing to
// give them is the website, not an isolated card. It is still reached from every context,
// which is why both destinations stay: "Browse events" for a visitor, "Go to dashboard"
// for an organizer who mistyped a path.
//
// Next.js renders this inside the ROOT layout only — route-group layouts are skipped for
// an unmatched path — so there is no possibility of the dashboard or admin shell nesting
// around it and producing two headers.
export default function NotFound() {
  return (
    <HomeShell>
      <Container className="flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
        <div className="flex size-20 items-center justify-center rounded-full bg-muted">
          <Compass className="size-9 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Page not found
        </h1>
        <p className="mt-3 max-w-sm text-sm text-muted-foreground">
          The page you are looking for does not exist or may have moved.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/" className={marketingButton({ variant: 'primary' })}>
            Go Home
          </Link>
          <Link href="/dashboard" className={marketingButton({ variant: 'outline' })}>
            Go to Dashboard
          </Link>
        </div>
      </Container>
    </HomeShell>
  )
}
