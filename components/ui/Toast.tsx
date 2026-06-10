'use client'

// Lightweight toast system — no external dependencies.
// Wraps the dashboard layout; all children call useToast() to fire toasts.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id:      string
  type:    ToastType
  message: string
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

export const ToastContext = createContext<ToastContextValue>({
  showToast: () => undefined,
})

export function useToast() {
  return useContext(ToastContext)
}

// ─── Auto-dismiss timer ───────────────────────────────────────────────────────

const DISMISS_MS = 4500

// ─── Single toast item ────────────────────────────────────────────────────────

function ToastChip({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(item.id), DISMISS_MS)
    return () => clearTimeout(timerRef.current)
  }, [item.id, onDismiss])

  const { icon: Icon, border, bg, text } = {
    success: {
      icon:   CheckCircle2,
      border: 'border-emerald-200',
      bg:     'bg-emerald-50',
      text:   'text-emerald-800',
    },
    error: {
      icon:   AlertCircle,
      border: 'border-red-200',
      bg:     'bg-red-50',
      text:   'text-red-800',
    },
    info: {
      icon:   Info,
      border: 'border-border',
      bg:     'bg-card',
      text:   'text-foreground',
    },
  }[item.type]

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0,  scale: 1     }}
      exit={{    opacity: 0, y: 8,  scale: 0.97  }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg',
        border, bg,
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', text)} aria-hidden />
      <p className={cn('flex-1 text-[13px] font-medium leading-snug', text)}>{item.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        className={cn('rounded-lg p-0.5 opacity-60 transition-opacity hover:opacity-100', text)}
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  )
}

// ─── Provider + portal ────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  let counter = 0

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = `toast-${Date.now()}-${counter++}`
    setToasts(prev => [...prev.slice(-4), { id, type, message }])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* Fixed portal — bottom-right on desktop, bottom-center on mobile */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[calc(100vw-2rem)] flex-col gap-2 sm:w-auto sm:max-w-sm"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {toasts.map(t => (
            <div key={t.id} className="pointer-events-auto">
              <ToastChip item={t} onDismiss={dismiss} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
