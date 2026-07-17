'use client'

// Lightweight toast system — no external dependencies (EA-4 S3: extended, not replaced).
// Wraps the dashboard/admin/attendee layouts; children call useToast() to fire toasts.
//
// Backward compatible: showToast(message, type) still works. EA-4 S3 adds a `warning`
// variant, an options overload { title, action, duration }, and DUAL live regions
// (success/info → polite; error/warning → assertive role="alert").

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction { label: string; onClick: () => void }
export interface ToastOptions { title?: string; action?: ToastAction; duration?: number }

export interface ToastItem {
  id:       string
  type:     ToastType
  message:  string
  title?:   string
  action?:  ToastAction
  duration?: number
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, options?: ToastOptions) => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

export const ToastContext = createContext<ToastContextValue>({
  showToast: () => undefined,
})

export function useToast() {
  return useContext(ToastContext)
}

// ─── Style map (assertive drives the live-region routing) ──────────────────────

const DISMISS_MS = 4500

const STYLES: Record<ToastType, { icon: typeof Info; border: string; bg: string; text: string; assertive: boolean }> = {
  success: { icon: CheckCircle2,  border: 'border-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-800', assertive: false },
  error:   { icon: AlertCircle,   border: 'border-red-200',     bg: 'bg-red-50',     text: 'text-red-800',     assertive: true  },
  warning: { icon: AlertTriangle, border: 'border-amber-200',   bg: 'bg-amber-50',   text: 'text-amber-800',   assertive: true  },
  info:    { icon: Info,          border: 'border-border',      bg: 'bg-card',       text: 'text-foreground',  assertive: false },
}

// ─── Single toast item ────────────────────────────────────────────────────────

function ToastChip({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(item.id), item.duration ?? DISMISS_MS)
    return () => clearTimeout(timerRef.current)
  }, [item.id, item.duration, onDismiss])

  const s = STYLES[item.type]
  const Icon = s.icon

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0,  scale: 1     }}
      exit={{    opacity: 0, y: 8,  scale: 0.97  }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn('flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg', s.border, s.bg)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', s.text)} aria-hidden />
      <div className="min-w-0 flex-1">
        {item.title && <p className={cn('text-[13px] font-semibold leading-snug', s.text)}>{item.title}</p>}
        <p className={cn('text-[13px] font-medium leading-snug', s.text, item.title && 'opacity-90')}>{item.message}</p>
        {item.action && (
          <button
            type="button"
            onClick={() => { item.action!.onClick(); onDismiss(item.id) }}
            className={cn('mt-1.5 text-[12px] font-semibold underline underline-offset-2 hover:opacity-80', s.text)}
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        className={cn('rounded-lg p-0.5 opacity-60 transition-opacity hover:opacity-100', s.text)}
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
  const counter = useRef(0)

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const showToast = useCallback((message: string, type: ToastType = 'info', options?: ToastOptions) => {
    const id = `toast-${Date.now()}-${counter.current++}`
    setToasts(prev => [...prev.slice(-4), { id, type, message, title: options?.title, action: options?.action, duration: options?.duration }])
  }, [])

  const assertive = toasts.filter(t => STYLES[t.type].assertive)   // error / warning
  const polite    = toasts.filter(t => !STYLES[t.type].assertive)  // success / info

  const region = (items: ToastItem[]) => (
    <AnimatePresence mode="popLayout" initial={false}>
      {items.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <ToastChip item={t} onDismiss={dismiss} />
        </div>
      ))}
    </AnimatePresence>
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      {/* One visual stack; TWO live regions — urgent (error/warning) above transient. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[calc(100vw-2rem)] flex-col gap-2 sm:w-auto sm:max-w-sm">
        <div role="alert" aria-live="assertive" aria-atomic="false" className="flex flex-col gap-2">
          {region(assertive)}
        </div>
        <div aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
          {region(polite)}
        </div>
      </div>
    </ToastContext.Provider>
  )
}
