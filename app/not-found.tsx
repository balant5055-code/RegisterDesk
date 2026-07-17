import Link from 'next/link'
import { Compass } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'

// GA-7D S2: branded root 404 (was Next.js's unstyled default). Mirrors the existing
// events/[slug]/not-found pattern; self-contained so it renders correctly in any
// context (public, dashboard, admin) and always offers a route back into the app.
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-20 text-center">
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
        <Link href="/" className={buttonVariants({ variant: 'primary' })}>
          Go Home
        </Link>
        <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}
