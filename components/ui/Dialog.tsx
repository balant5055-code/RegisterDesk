'use client'

// Shared accessible Dialog primitive (EA-4 S3). Reuses the existing useFocusTrap —
// it does NOT introduce a new dialog framework. Provides role="dialog" +
// aria-modal, focus trap + restore, Escape-to-close, and a backdrop. New/migrated
// modals mount their content inside <Dialog>; ConfirmDialog remains as-is.

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

export interface DialogProps {
  open:             boolean
  onClose:          () => void
  title?:           string
  children:         React.ReactNode
  footer?:          React.ReactNode
  size?:            'sm' | 'md' | 'lg'
  closeOnBackdrop?: boolean
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const

export function Dialog({ open, onClose, title, children, footer, size = 'md', closeOnBackdrop = true }: DialogProps) {
  const ref = useFocusTrap<HTMLDivElement>(open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={closeOnBackdrop ? onClose : undefined} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'rd-dialog-title' : undefined}
        className={cn('relative z-10 w-full rounded-2xl border border-border bg-card shadow-xl', SIZES[size])}
      >
        {title && (
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <h2 id="rd-dialog-title" className="text-[15px] font-semibold text-foreground">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
