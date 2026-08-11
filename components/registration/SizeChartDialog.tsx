'use client'

// Apparel size chart modal for a registration form field.
//
// Built on the existing <Dialog> primitive, so focus trapping, the Escape key, the
// backdrop and the labelled-dialog semantics all come from the component the rest of the
// app already uses — there is no second modal implementation here.
//
// Read-only by construction: it renders tables and holds no form state, so opening or
// closing it cannot touch the selected size, trigger validation, or submit anything.

import { Dialog } from '@/components/ui/Dialog'
import { resolveSizeChart, hasMeasurements, type SizeChart, type SizeChartRow } from '@/lib/registrations/sizeChart'

const TH = 'px-3 py-2 text-left text-fs-2xs font-bold uppercase tracking-wider text-muted-foreground'
const TD = 'px-3 py-2 text-fs-sm text-foreground'

function ChartTable({ caption, rows, measurements }: {
  caption: string
  rows: SizeChartRow[]
  measurements: boolean
}) {
  if (rows.length === 0) return null
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="mb-2 text-fs-sm font-bold text-foreground">{caption}</h3>
      {/* The SCROLLER is this wrapper, not the page: overflow-x lives here so a narrow
          phone scrolls the table alone and the document never scrolls sideways. */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[22rem] border-collapse">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted/40">
            <tr>
              <th scope="col" className={TH}>Brand Size</th>
              <th scope="col" className={TH}>Standard Size</th>
              {measurements && <>
                <th scope="col" className={TH}>Chest (in)</th>
                <th scope="col" className={TH}>Shoulder (in)</th>
                <th scope="col" className={TH}>Length (in)</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.brandSize}-${i}`} className="border-t border-border/60">
                <td className={`${TD} font-semibold`}>{r.brandSize}</td>
                <td className={TD}>{r.standardSize}</td>
                {measurements && <>
                  <td className={TD}>{r.chest ?? '—'}</td>
                  <td className={TD}>{r.shoulder ?? '—'}</td>
                  <td className={TD}>{r.length ?? '—'}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function SizeChartDialog({ open, onClose, chart, title = 'Size Chart' }: {
  open:    boolean
  onClose: () => void
  chart:   SizeChart
  title?:  string
}) {
  const resolved = resolveSizeChart(chart)

  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg">
      <ChartTable caption="Regular Sizes" rows={resolved.regular} measurements={hasMeasurements(resolved.regular)} />
      <ChartTable caption="Kids Sizes"    rows={resolved.kids}    measurements={hasMeasurements(resolved.kids)} />
      {resolved.note && (
        <p className="mt-4 text-fs-2xs text-muted-foreground">{resolved.note}</p>
      )}
    </Dialog>
  )
}
