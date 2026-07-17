import { Container } from '@/components/ui/Container'

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-muted ${className ?? ''}`} aria-hidden />
  )
}

export default function CampaignPageLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero skeleton */}
      <div className="h-[240px] w-full animate-pulse bg-muted sm:h-[320px] lg:h-[380px]" />

      <Container className="py-6 sm:py-8 lg:py-10">
        {/* Back link */}
        <Skeleton className="mb-6 h-4 w-16 rounded" />

        <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-10 xl:gap-14">
          {/* Left */}
          <div className="flex flex-col gap-8">
            {/* Title block */}
            <div className="space-y-3">
              <Skeleton className="h-5 w-28 rounded-full" />
              <Skeleton className="h-9 w-4/5 rounded-lg" />
              <Skeleton className="h-5 w-3/5 rounded-lg" />
              <Skeleton className="h-4 w-2/5 rounded" />
            </div>

            {/* Progress card — mobile */}
            <div className="rounded-2xl border border-border p-5 lg:hidden space-y-4">
              <Skeleton className="h-8 w-48 rounded-lg" />
              <Skeleton className="h-2 w-full rounded-full" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Skeleton className="h-10 rounded-lg" />
                <Skeleton className="h-10 rounded-lg" />
                <Skeleton className="h-10 rounded-lg" />
              </div>
            </div>

            {/* Donation widget — mobile */}
            <div className="rounded-2xl border border-border p-5 lg:hidden space-y-3">
              <Skeleton className="h-5 w-40 rounded" />
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-12 w-full rounded-xl" />
              <Skeleton className="h-11 w-full rounded-xl" />
            </div>

            {/* Trust badges */}
            <div className="flex gap-3">
              <Skeleton className="h-8 w-40 rounded-full" />
              <Skeleton className="h-8 w-36 rounded-full" />
            </div>

            {/* Story */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-44 rounded-lg" />
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className={`h-4 rounded ${i === 5 ? 'w-3/4' : 'w-full'}`} />
                ))}
              </div>
            </div>

            {/* Beneficiary */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-36 rounded-lg" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>

            {/* Organizer */}
            <div className="space-y-3">
              <Skeleton className="h-6 w-44 rounded-lg" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
          </div>

          {/* Right sticky sidebar (desktop) */}
          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-5">
              {/* Progress card */}
              <div className="rounded-2xl border border-border p-5 space-y-4">
                <Skeleton className="h-8 w-48 rounded-lg" />
                <Skeleton className="h-2 w-full rounded-full" />
                <div className="grid grid-cols-3 gap-3">
                  <Skeleton className="h-10 rounded-lg" />
                  <Skeleton className="h-10 rounded-lg" />
                  <Skeleton className="h-10 rounded-lg" />
                </div>
              </div>

              {/* Donation widget */}
              <div className="rounded-2xl border border-border p-5 space-y-3">
                <Skeleton className="h-5 w-40 rounded" />
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 rounded-xl" />
                  ))}
                </div>
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-11 w-full rounded-xl" />
              </div>
            </div>
          </div>
        </div>
      </Container>
    </div>
  )
}
