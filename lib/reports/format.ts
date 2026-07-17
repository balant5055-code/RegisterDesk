// Centralized value formatting + time helpers for reports. Every exporter routes
// money/date rendering through here so there is one source of truth.

import type { ReportCell, ReportColumnType } from '@/lib/reports/types'

/** Firestore Timestamp | ISO string | {seconds} | null → epoch millis (0 if unknown). */
export function toMillis(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000   // ms vs unix-seconds
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  const s = (v as { _seconds?: number; seconds?: number })._seconds ?? (v as { seconds?: number }).seconds
  return typeof s === 'number' ? s * 1000 : 0
}

/** → ISO string (or null) for storage in report cells. */
export function toISO(v: unknown): string | null {
  const ms = toMillis(v)
  return ms > 0 ? new Date(ms).toISOString() : null
}

/** Inclusive UTC day bounds from 'YYYY-MM-DD' filters. */
export function rangeBounds(from?: string, to?: string): { fromMs: number; toMs: number } {
  const fromMs = from ? Date.parse(`${from}T00:00:00.000Z`) : 0
  const toMs   = to   ? Date.parse(`${to}T23:59:59.999Z`)   : Number.MAX_SAFE_INTEGER
  return {
    fromMs: Number.isNaN(fromMs) ? 0 : fromMs,
    toMs:   Number.isNaN(toMs)   ? Number.MAX_SAFE_INTEGER : toMs,
  }
}

export const paiseToRupees = (paise: number): number => Math.round(paise) / 100

/** Human ₹ string. ascii=true uses "Rs " (PDF: standard fonts can't encode ₹). */
export function fmtMoney(paise: number, ascii = false): string {
  const n = paiseToRupees(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return ascii ? `Rs ${n}` : `₹${n}`
}

/** Readable date for PDF/CSV display. */
export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Display rendering of a cell for PDF/CSV/UI (human readable). */
export function cellToDisplay(value: ReportCell, type: ReportColumnType, ascii = false): string {
  if (value == null || value === '') return type === 'money' ? fmtMoney(0, ascii) : '—'
  switch (type) {
    case 'money':  return fmtMoney(typeof value === 'number' ? value : Number(value) || 0, ascii)
    case 'date':   return fmtDate(typeof value === 'string' ? value : null)
    case 'number': return typeof value === 'number' ? value.toLocaleString('en-IN') : String(value)
    default:       return String(value)
  }
}

/** Numeric/string value of a cell for XLSX (money → rupees number so Excel sums). */
export function cellToXlsx(value: ReportCell, type: ReportColumnType): { v: number | string; numeric: boolean } {
  if (value == null) return { v: '', numeric: false }
  if (type === 'money')  return { v: paiseToRupees(typeof value === 'number' ? value : Number(value) || 0), numeric: true }
  if (type === 'number' && typeof value === 'number') return { v: value, numeric: true }
  if (type === 'date')   return { v: fmtDate(typeof value === 'string' ? value : null), numeric: false }
  return { v: String(value), numeric: false }
}
