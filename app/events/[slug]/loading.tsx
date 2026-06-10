import { Container } from '@/components/ui/Container'

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-muted ${className ?? ''}`} aria-hidden />
  )
}

export default function EventPageLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero skeleton */}
      <div className="relative h-[380px] w-full bg-muted sm:h-[480px] lg:h-[540px]">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted to-muted/60" />
        <Container className="absolute bottom-0 left-0 right-0 pb-8 sm:pb-10">
          <div className="flex items-end gap-4">
            <Skeleton className="mb-1 size-[68px] shrink-0 rounded-2xl sm:size-20" />
            <div className="flex-1 space-y-2 pb-1">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-9 w-3/4 rounded-lg" />
              <Skeleton className="h-5 w-1/2 rounded-lg" />
              <div className="mt-3 flex gap-2">
                <Skeleton className="h-8 w-40 rounded-full" />
                <Skeleton className="h-8 w-32 rounded-full" />
              </div>
            </div>
          </div>
        </Container>
      </div>

      {/* Body skeleton */}
      <Container className="py-8 sm:py-10">
        <div className="lg:grid lg:grid-cols-[1fr_360px] lg:gap-8">
          {/* Left */}
          <div className="flex flex-col gap-10">
            {/* Venue */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-32 rounded-lg" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
            {/* Description */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-40 rounded-lg" />
              <div className="space-y-2 rounded-xl border border-border p-5">
                <Skeleton className="h-4 w-full rounded" />
                <Skeleton className="h-4 w-full rounded" />
                <Skeleton className="h-4 w-3/4 rounded" />
                <Skeleton className="h-4 w-5/6 rounded" />
                <Skeleton className="h-4 w-2/3 rounded" />
              </div>
            </div>
            {/* Agenda */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-28 rounded-lg" />
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          </div>

          {/* Right */}
          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-4">
              <Skeleton className="h-32 w-full rounded-2xl" />
              <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
          </div>
        </div>
      </Container>
    </div>
  )
}
