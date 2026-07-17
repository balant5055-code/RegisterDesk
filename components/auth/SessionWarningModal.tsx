'use client'

import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, LogOut, RefreshCw } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface SessionWarningModalProps {
  open:           boolean
  countdown:      number          // seconds remaining until forced logout
  onStaySignedIn: () => void
  onLogout:       () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SessionWarningModal({
  open,
  countdown,
  onStaySignedIn,
  onLogout,
}: SessionWarningModalProps) {
  // GA-7D S1: reuse the shared focus trap (trap + restore) and autofocus the safe,
  // non-destructive action so Enter keeps the user signed in. Escape also = stay
  // signed in. role/aria-modal/aria-live were already present.
  const trapRef = useFocusTrap<HTMLDivElement>(open)
  const stayRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const id  = setTimeout(() => stayRef.current?.focus(), 30)   // wins over the trap's first-focus
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onStaySignedIn() } }
    document.addEventListener('keydown', key)
    return () => { clearTimeout(id); document.removeEventListener('keydown', key) }
  }, [open, onStaySignedIn])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={trapRef}
          key="session-warning-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          aria-modal="true"
          role="alertdialog"
          aria-labelledby="session-warning-title"
          aria-describedby="session-warning-desc"
        >
          <motion.div
            key="session-warning-panel"
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1,    y: 0 }}
            exit={{ opacity: 0,   scale: 0.95, y: 8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-start gap-3 border-b border-border px-5 py-4">
              <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100">
                <AlertCircle className="size-4.5 text-amber-600" aria-hidden />
              </div>
              <div>
                <p id="session-warning-title" className="text-[15px] font-bold text-foreground">
                  Session Expiring Soon
                </p>
                <p id="session-warning-desc" className="mt-0.5 text-[12.5px] text-muted-foreground">
                  You will be signed out due to inactivity.
                </p>
              </div>
            </div>

            {/* Countdown */}
            <div className="flex flex-col items-center gap-1 px-5 py-7">
              <p
                className="text-[3.5rem] font-extrabold tabular-nums leading-none text-amber-600"
                aria-live="polite"
                aria-atomic="true"
                aria-label={`${fmtCountdown(countdown)} remaining`}
              >
                {fmtCountdown(countdown)}
              </p>
              <p className="text-[12.5px] text-muted-foreground">remaining before sign-out</p>
            </div>

            {/* Actions */}
            <div className="flex gap-3 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={onLogout}
                className={cn(buttonVariants({ variant: 'outline' }), 'flex-1 gap-2')}
              >
                <LogOut className="size-3.5 shrink-0" aria-hidden />
                Sign Out
              </button>
              <button
                ref={stayRef}
                type="button"
                onClick={onStaySignedIn}
                className={cn(buttonVariants({ variant: 'primary' }), 'flex-1 gap-2')}
              >
                <RefreshCw className="size-3.5 shrink-0" aria-hidden />
                Stay Signed In
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
