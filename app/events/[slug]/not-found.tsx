import Link from 'next/link'
import { CalendarX } from 'lucide-react'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { Container }      from '@/components/ui/Container'
import { buttonVariants } from '@/components/ui/button'
import { ROUTES }         from '@/config/navigation'

export default function EventNotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <MarketingNavbar />
      <Container className="flex flex-1 flex-col items-center justify-center py-20 text-center">
        <div className="flex size-20 items-center justify-center rounded-full bg-muted">
          <CalendarX className="size-9 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Event not found
        </h1>
        <p className="mt-3 max-w-sm text-sm text-muted-foreground">
          This event may have been removed, made private, or the link might be incorrect.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href={ROUTES.EVENTS} className={buttonVariants({ variant: 'primary' })}>
            Browse Events
          </Link>
          <Link href={ROUTES.HOME} className={buttonVariants({ variant: 'outline' })}>
            Go Home
          </Link>
        </div>
      </Container>
    </div>
  )
}
