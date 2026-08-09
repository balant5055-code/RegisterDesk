// RD-RT3.3 — the skeleton now mirrors the real page.
//
// It used to be a single `max-w-xl` centred column while the page renders `max-w-7xl`
// with a compact header, a journey stepper and a 65/35 grid. Every load therefore ended
// in a visible jump: a narrow column snapping out to a full-width two-column checkout.
// Matching the real geometry means the skeleton occupies the space the content will
// occupy, so nothing moves when it arrives.

function Bar({ className }: { className: string }) {
  return <div className={`rounded-md bg-muted ${className}`} />
}

export default function RegisterLoading() {
  return (
    <div
      role="status"
      aria-label="Loading registration"
      className="mx-auto w-full max-w-7xl animate-pulse px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-16 lg:pt-8"
    >
      {/* Compact checkout header — logo bar, title, subtitle, breadcrumb. */}
      <div className="mb-4">
        <div className="-mx-4 mb-3 flex h-12 items-center justify-between border-b border-border/60 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <Bar className="h-6 w-32" />
          <Bar className="h-3 w-24" />
        </div>
        <Bar className="h-7 w-72 max-w-full rounded-lg" />
        <Bar className="mt-1.5 h-4 w-56 max-w-full" />
        <Bar className="mt-2.5 h-3 w-64 max-w-full" />
      </div>

      {/* Journey stepper — four stages. */}
      <div className="mb-4 flex items-center gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="flex flex-1 items-center gap-2">
            <div className="size-6 shrink-0 rounded-full bg-muted" />
            <Bar className="hidden h-3 w-20 sm:block" />
            {i < 3 && <span className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)] lg:gap-8">
        {/* Form column */}
        <div className="flex flex-col gap-4">
          {[0, 1].map(s => (
            <div key={s} className="rounded-2xl border border-border/50 bg-card shadow-sm">
              <div className="flex items-center gap-3 rounded-t-2xl border-b border-border/60 bg-muted/[0.03] px-5 py-4">
                <div className="size-6 shrink-0 rounded-lg bg-muted" />
                <Bar className="h-4 w-40" />
              </div>
              <div className="flex flex-col gap-4 px-5 py-5">
                {[0, 1, 2].map(i => (
                  <div key={i}>
                    <Bar className="mb-1 h-3.5 w-28" />
                    <Bar className="h-10 w-full rounded-xl" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Sticky summary column — desktop only, exactly as the page renders it. */}
        <div className="mt-4 hidden lg:mt-0 lg:block">
          <div className="rounded-2xl border border-border/50 bg-card shadow-sm">
            <div className="aspect-[21/8] rounded-t-2xl bg-muted" />
            <div className="flex flex-col gap-3 p-4">
              <Bar className="h-3.5 w-32" />
              <Bar className="h-3 w-40" />
              <Bar className="h-3 w-36" />
              <Bar className="mt-1 h-6 w-24 self-end" />
              <Bar className="mt-1 h-11 w-full rounded-xl" />
            </div>
          </div>
        </div>
      </div>

      <span className="sr-only">Loading registration…</span>
    </div>
  )
}
