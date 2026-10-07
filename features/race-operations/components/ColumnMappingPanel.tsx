'use client'

// RD-RACEOPS-01 Sprint 2 · Column mapping.
//
// A results file comes from a third-party timing system, so no fixed format can be
// required. Each canonical field picks the uploaded header that feeds it. Auto-detection
// pre-fills the obvious ones; the organizer can change any of them.
//
// Mapping lives in memory for this session only — nothing is persisted (per brief).
//
// A native <select> is used deliberately: components/ui/CustomSelect takes
// `options: string[]` and selects BY LABEL, so it cannot express "this canonical field →
// that header" without inventing a parallel label-to-value lookup. A native select is
// also keyboard- and screen-reader-correct for free, and styled entirely from tokens.

import { AlertTriangle, Check, Search } from 'lucide-react'
import { Card } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { RESULT_FIELDS, type ColumnMapping, type ResultField } from '@/features/race-operations/types/results'

const UNMAPPED_VALUE = '__unmapped__'

export interface ColumnMappingPanelProps {
  headers:         readonly string[]
  mapping:         ColumnMapping
  /**
   * RD-RACEOPS-02C · how each mapping was decided. `exact` shows "Automatically detected";
   * `review` shows "Review required" (a generic heading such as Finish Time, a substring
   * guess, or two competing columns) — never a tick; `manual` shows "Set by you".
   */
  source?:         Partial<Record<ResultField, 'exact' | 'review' | 'manual'>>
  missingRequired: readonly ResultField[]
  onChange:        (field: ResultField, header: string | null) => void
}

const SOURCE_BADGE: Record<'exact' | 'review' | 'manual', { label: string; cls: string; icon: typeof Check }> = {
  exact:  { label: 'Automatically detected', cls: 'bg-success/10 text-success',              icon: Check },
  review: { label: 'Review required',        cls: 'bg-warning/10 text-warning',              icon: Search },
  manual: { label: 'Set by you',             cls: 'bg-muted text-foreground',                icon: Check },
}

export function ColumnMappingPanel({
  headers, mapping, source = {}, missingRequired, onChange,
}: ColumnMappingPanelProps) {
  const reviewCount = RESULT_FIELDS.filter(f => mapping[f.field] && source[f.field] === 'review').length
  // A header already used by another field is shown but marked, so a double-mapping is
  // visible rather than silent.
  const usageCount = new Map<string, number>()
  for (const header of Object.values(mapping)) {
    if (header) usageCount.set(header, (usageCount.get(header) ?? 0) + 1)
  }

  return (
    <Card>
      <div className="space-y-4">
        {reviewCount > 0 && (
          <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5">
            <Search className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="text-fs-sm leading-relaxed text-foreground">
              {reviewCount === 1 ? 'One column was guessed' : `${reviewCount} columns were guessed`} from a heading that
              could mean more than one thing. Check the fields marked{' '}
              <span className="font-semibold">Review required</span> before continuing.
            </p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {RESULT_FIELDS.map(({ field, label, required, description }) => {
            const value   = mapping[field] ?? UNMAPPED_VALUE
            const missing = required && !mapping[field]
            const doubled = Boolean(mapping[field]) && (usageCount.get(mapping[field]!) ?? 0) > 1
            const badge   = mapping[field] && !missing ? SOURCE_BADGE[source[field] ?? 'manual'] : null
            return (
              <div key={field} className="space-y-1.5">
                <label
                  htmlFor={`raceops-map-${field}`}
                  className="flex items-center gap-1.5 text-fs-sm font-medium text-foreground"
                >
                  {label}
                  {required && <span className="text-destructive" aria-label="required">*</span>}
                  {badge && (
                    <span className={cn('ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-fs-2xs font-medium', badge.cls)}>
                      <badge.icon className="size-3" aria-hidden />{badge.label}
                    </span>
                  )}
                </label>

                <select
                  id={`raceops-map-${field}`}
                  value={value}
                  aria-invalid={missing || undefined}
                  aria-describedby={`raceops-map-${field}-hint`}
                  onChange={e => onChange(field, e.target.value === UNMAPPED_VALUE ? null : e.target.value)}
                  className={cn(
                    'w-full rounded-lg border bg-card px-3 py-2 text-fs-base text-foreground',
                    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    missing ? 'border-destructive/60' : 'border-border hover:border-border-strong',
                  )}
                >
                  <option value={UNMAPPED_VALUE}>
                    {required ? '— Select a column —' : '— Not in this file —'}
                  </option>
                  {headers.filter(h => h !== '').map(header => (
                    <option key={header} value={header}>{header}</option>
                  ))}
                </select>

                <p
                  id={`raceops-map-${field}-hint`}
                  className={cn(
                    'text-fs-2xs leading-relaxed',
                    missing ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {missing ? `${label} is required — choose the column that holds it.` : description}
                  {doubled && ' This column is also used by another field.'}
                </p>
              </div>
            )
          })}
        </div>

        {missingRequired.length > 0 && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="text-fs-sm leading-relaxed text-foreground">
              Map every required column to continue. Still needed:{' '}
              <span className="font-semibold">
                {missingRequired
                  .map(f => RESULT_FIELDS.find(d => d.field === f)?.label ?? f)
                  .join(', ')}
              </span>.
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}
