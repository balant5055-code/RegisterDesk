export default function RegisterLoading() {
  return (
    <div className="mx-auto max-w-xl animate-pulse px-4 py-10">
      {/* Header skeleton */}
      <div className="mb-6">
        <div className="h-3 w-28 rounded-full bg-muted" />
        <div className="mt-2 h-7 w-64 rounded-lg bg-muted" />
        <div className="mt-2 h-4 w-40 rounded-md bg-muted" />
      </div>

      {/* Pass card skeleton */}
      <div className="mb-6 h-16 rounded-xl bg-muted" />

      {/* Section skeleton */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border/60 bg-muted/[0.03] px-5 py-3.5">
          <div className="h-4 w-36 rounded-md bg-muted" />
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">
          {[1, 2, 3].map(i => (
            <div key={i}>
              <div className="mb-1.5 h-3.5 w-24 rounded-md bg-muted" />
              <div className="h-10 w-full rounded-xl bg-muted" />
            </div>
          ))}
        </div>
      </div>

      {/* Button skeleton */}
      <div className="mt-6 h-12 w-full rounded-xl bg-muted" />
    </div>
  )
}
