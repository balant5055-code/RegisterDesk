import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Admin data-table primitives ────────────────────────────────────────────────
// One table chrome for every Platform Admin list. Pages keep their bespoke columns
// and cells — these primitives only own the shared frame, density, header styling,
// row dividers, and hover so tables stop drifting (radius, padding, type scale).
//
// Standard density (matches the organizers / audit tables):
//   frame  overflow-x-auto rounded-xl border   table text-[13.5px]
//   head   bg-muted/40  text-[12px] font-semibold  th px-4 py-2.5
//   body   divide-y                              td px-4 py-3   row hover:bg-muted/20

type Align = 'left' | 'right' | 'center'

const alignClass: Record<Align, string> = {
  left:   'text-left',
  right:  'text-right',
  center: 'text-center',
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export interface TableFrameProps extends HTMLAttributes<HTMLTableElement> {
  /** Minimum table width before the frame scrolls horizontally, e.g. "min-w-[760px]". */
  minWidth?: string
  children: ReactNode
}

export function TableFrame({ minWidth, className, children, ...props }: TableFrameProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className={cn('w-full text-[13.5px]', minWidth, className)} {...props}>
        {children}
      </table>
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────────────────

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
        {children}
      </tr>
    </thead>
  )
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: Align
}

export function Th({ align = 'left', className, children, ...props }: ThProps) {
  return (
    <th className={cn('px-4 py-2.5', alignClass[align], className)} {...props}>
      {children}
    </th>
  )
}

// ── Body ────────────────────────────────────────────────────────────────────────

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>
}

export type TrProps = HTMLAttributes<HTMLTableRowElement>

export function Tr({ onClick, className, children, ...props }: TrProps) {
  return (
    <tr
      onClick={onClick}
      className={cn('hover:bg-muted/20', onClick && 'cursor-pointer', className)}
      {...props}
    >
      {children}
    </tr>
  )
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: Align
}

export function Td({ align = 'left', className, children, ...props }: TdProps) {
  return (
    <td className={cn('px-4 py-3', alignClass[align], className)} {...props}>
      {children}
    </td>
  )
}

// ── Full-width state row (loading / empty), consistent height + centring ─────────

export function TableStateRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-muted-foreground">
        {children}
      </td>
    </tr>
  )
}
