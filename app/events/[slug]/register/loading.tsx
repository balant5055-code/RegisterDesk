// RD-RT4.0 — the skeleton mirrors the real page.
//
// It must occupy the space the content will occupy, or every load ends in a visible
// jump. That now includes the canvas and the sticky checkout bar: a white skeleton
// followed by a tinted page is the same jump in a different form.

import { CANVAS_STYLE, CANVAS, PAGE, PANEL } from './registerTheme'

function Bar({ className }: { className: string }) {
  return <div className={`rounded-md bg-muted ${className}`} />
}

export default function RegisterLoading() {
  return (
    <div style={CANVAS_STYLE} className={`min-h-screen ${CANVAS}`}>
      {/* Checkout chrome — same 56px bar the real page pins to the top. */}
      <div className="sticky top-0 z-50 border-b border-border/70 bg-card/85 backdrop-blur-xl">
        <div className={`${PAGE} flex h-14 items-center justify-between gap-4`}>
          <Bar className="h-6 w-32" />
          <Bar className="h-3 w-28" />
        </div>
      </div>

      <div
        role="status"
        aria-label="Loading registration"
        className={`${PAGE} animate-pulse pb-32 lg:pb-20 motion-reduce:animate-none`}
      >
        {/* Masthead — breadcrumb, eyebrow, title, sentence, fact chips. */}
        <div className="pt-6 pb-5 sm:pt-8 sm:pb-7">
          <Bar className="h-3 w-64 max-w-full" />
          <Bar className="mt-4 h-3 w-28" />
          <Bar className="mt-2 h-7 w-80 max-w-full rounded-lg" />
          <Bar className="mt-2.5 h-4 w-96 max-w-full" />
          <div className="mt-4 flex gap-2">
            {[0, 1, 2].map(i => <Bar key={i} className="h-6 w-28 rounded-full" />)}
          </div>
        </div>

        {/* Journey stepper panel — four nodes with labels beneath. */}
        <div className={`${PANEL} mb-4 px-4 py-4 sm:px-6 sm:py-5`}>
          <div className="mb-4 flex items-baseline justify-between">
            <Bar className="h-3 w-28" />
            <Bar className="h-3 w-16" />
          </div>
          <div className="flex items-start">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="relative flex flex-1 flex-col items-center">
                {i < 3 && <span className="absolute left-1/2 top-[13px] h-0.5 w-full bg-border" />}
                <div className="relative z-10 size-7 rounded-full bg-muted" />
                <Bar className="mt-2 h-2.5 w-16" />
              </div>
            ))}
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[minmax(0,64fr)_minmax(0,36fr)] lg:gap-8">
          {/* Form column */}
          <div className="flex flex-col gap-4">
            {[0, 1].map(s => (
              <div key={s} className={PANEL}>
                <div className="flex items-center gap-3 rounded-t-2xl border-b border-border/60 px-5 py-4 sm:px-6">
                  <div className="size-7 shrink-0 rounded-xl bg-muted" />
                  <Bar className="h-4 w-44" />
                </div>
                <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
                  {[0, 1, 2].map(i => (
                    <div key={i}>
                      <Bar className="mb-1.5 h-3.5 w-28" />
                      <Bar className="h-10 w-full rounded-xl" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Sticky summary column — desktop only, exactly as the page renders it. */}
          <div className="mt-4 hidden lg:mt-0 lg:block">
            <div className={PANEL}>
              <div className="aspect-[21/7] rounded-t-2xl bg-muted" />
              <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
                <Bar className="h-3 w-20" />
                <Bar className="h-4 w-40" />
                <Bar className="h-3 w-48" />
                <Bar className="h-3 w-36" />
              </div>
              <div aria-hidden className="mx-4 border-t border-dashed border-border" />
              <div className="flex flex-col gap-3 px-5 pt-5 pb-5">
                <Bar className="h-8 w-28 self-end" />
                <Bar className="h-11 w-full rounded-lg" />
              </div>
              <div className="flex flex-col gap-2 rounded-b-2xl border-t border-border/60 bg-muted/40 px-5 py-4">
                {[0, 1, 2].map(i => <Bar key={i} className="h-2.5 w-40" />)}
              </div>
            </div>
          </div>
        </div>

        <span className="sr-only">Loading registration…</span>
      </div>
    </div>
  )
}
