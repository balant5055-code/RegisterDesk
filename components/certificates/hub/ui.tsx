'use client'

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export function Spinner() {
  return <div className="flex items-center justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{message}</div>
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  )
}

export function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[22px] font-bold leading-none text-foreground">{value}</p>
      <p className="mt-1 text-[12px] text-muted-foreground">{label}</p>
    </div>
  )
}

const BADGE: Record<string, string> = {
  green:  'bg-emerald-100 text-emerald-700',
  blue:   'bg-blue-100 text-blue-700',
  amber:  'bg-amber-100 text-amber-700',
  red:    'bg-red-100 text-red-700',
  gray:   'bg-muted text-muted-foreground',
}

export function Badge({ tone, children }: { tone: keyof typeof BADGE; children: React.ReactNode }) {
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold', BADGE[tone])}>{children}</span>
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</label>
}

export const inputCls = 'h-9 w-full rounded-lg border border-border bg-card px-3 text-[14px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25'
export const selectCls = 'h-9 w-full rounded-lg border border-border bg-card px-3 text-[14px] text-foreground focus:border-primary/40 focus:outline-none'
export const btnPrimary = 'flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60'
export const btnGhost = 'flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60'
