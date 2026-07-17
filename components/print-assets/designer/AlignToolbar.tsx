'use client'

// PA-9 S3 Part 4 — alignment / distribute / equal-size + z-order controls.
// Emits AlignOp values; the designer turns them into patches via align.ts.

import {
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
  StretchHorizontal, StretchVertical, ChevronUp, ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { AlignOp } from '@/lib/printAssets/designer/align'

export function AlignToolbar({ count, onAlign, onForward, onBackward }: {
  count: number
  onAlign: (op: AlignOp) => void
  onForward: () => void
  onBackward: () => void
}) {
  const multi = count > 1
  const three = count > 2
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-1">
        <Btn title="Align left" onClick={() => onAlign('left')}><AlignHorizontalJustifyStart className="size-4" /></Btn>
        <Btn title="Center horizontal" onClick={() => onAlign('center-h')}><AlignHorizontalJustifyCenter className="size-4" /></Btn>
        <Btn title="Align right" onClick={() => onAlign('right')}><AlignHorizontalJustifyEnd className="size-4" /></Btn>
        <Btn title="Align top" onClick={() => onAlign('top')}><AlignVerticalJustifyStart className="size-4" /></Btn>
        <Btn title="Center vertical" onClick={() => onAlign('center-v')}><AlignVerticalJustifyCenter className="size-4" /></Btn>
        <Btn title="Align bottom" onClick={() => onAlign('bottom')}><AlignVerticalJustifyEnd className="size-4" /></Btn>
      </div>
      <div className="grid grid-cols-6 gap-1">
        <Btn title="Distribute horizontally" disabled={!three} onClick={() => onAlign('distribute-h')}><AlignHorizontalDistributeCenter className="size-4" /></Btn>
        <Btn title="Distribute vertically" disabled={!three} onClick={() => onAlign('distribute-v')}><AlignVerticalDistributeCenter className="size-4" /></Btn>
        <Btn title="Equal width" disabled={!multi} onClick={() => onAlign('equal-w')}><StretchHorizontal className="size-4" /></Btn>
        <Btn title="Equal height" disabled={!multi} onClick={() => onAlign('equal-h')}><StretchVertical className="size-4" /></Btn>
        <Btn title="Bring forward" onClick={onForward}><ChevronUp className="size-4" /></Btn>
        <Btn title="Send backward" onClick={onBackward}><ChevronDown className="size-4" /></Btn>
      </div>
    </div>
  )
}

function Btn({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      className={cn('flex items-center justify-center rounded border border-border py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40')}>
      {children}
    </button>
  )
}
