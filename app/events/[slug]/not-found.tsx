import Link from 'next/link'
import { CalendarX } from 'lucide-react'
import { HomeShell }      from '@/components/discovery/home/HomeShell'
import { Container }      from '@/components/ui/Container'
import { marketingButton } from '@/lib/marketing/theme'
import { ROUTES }         from '@/config/navigation'

export default function EventNotFound() {
  return (
    <HomeShell>
      <Container className="flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
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
          <Link href={ROUTES.EVENTS} className={marketingButton({ variant: 'primary' })}>
            Browse Events
          </Link>
          <Link href={ROUTES.HOME} className={marketingButton({ variant: 'outline' })}>
            Go Home
          </Link>
        </div>
      </Container>
    </HomeShell>
  )
}
