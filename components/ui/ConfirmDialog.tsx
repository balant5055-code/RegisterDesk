'use client'

// Promise-based confirm / prompt dialogs — the production replacement for the
// native window.confirm()/window.prompt(). Mirrors the ToastProvider idiom: mount
// <ConfirmProvider> once per shell, then any child calls useConfirm() and awaits:
//
//   const { confirm, prompt } = useConfirm()
//   if (!(await confirm({ message: 'Delete this?', tone: 'danger' }))) return
//   const reason = (await prompt({ message: 'Reason:' , required: true }))?.trim()
//   if (!reason) return
//
// Branded, keyboard-accessible (Esc = cancel, Enter = confirm), focus-managed.
// No new dependencies — reuses framer-motion + the design tokens.

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

export interface ConfirmOptions {
  title?:        string
  message:       string
  confirmLabel?: string
  cancelLabel?:  string
  tone?:         'default' | 'danger'
}

export interface PromptOptions extends ConfirmOptions {
  placeholder?:  string
  defaultValue?: string
  required?:     boolean   // block confirm while the field is empty
  multiline?:    boolean
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt';  opts: PromptOptions;  resolve: (v: string | null) => void }

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  prompt:  (opts: PromptOptions) => Promise<string | null>
}

const ConfirmContext = createContext<ConfirmContextValue>({
  confirm: async () => false,
  prompt:  async () => null,
})

export function useConfirm() { return useContext(ConfirmContext) }

const EASE = [0.22, 1, 0.36, 1] as const

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [value,   setValue]   = useState('')
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  // GA-7D S1: reuse the shared focus trap (same hook Dialog uses) so Tab stays inside
  // the open dialog and focus returns to the trigger on close. role/aria-modal/Escape
  // were already present — this only adds the missing trap + restore.
  const trapRef = useFocusTrap<HTMLDivElement>(!!pending)

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>(resolve => {
    setValue('')
    setPending({ kind: 'confirm', opts, resolve })
  }), [])

  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>(resolve => {
    setValue(opts.defaultValue ?? '')
    setPending({ kind: 'prompt', opts, resolve })
  }), [])

  const settle = useCallback((result: boolean | string | null) => {
    if (!pending) return
    if (pending.kind === 'confirm') pending.resolve(result as boolean)
    else pending.resolve(result as string | null)
    setPending(null)
  }, [pending])

  const isPrompt = pending?.kind === 'prompt'
  const danger   = pending?.opts.tone === 'danger'
  const blocked  = isPrompt && (pending as { opts: PromptOptions }).opts.required === true && value.trim() === ''

  const cancel = useCallback(() => settle(pending?.kind === 'prompt' ? null : false), [pending, settle])
  const accept = useCallback(() => {
    if (blocked) return
    settle(pending?.kind === 'prompt' ? value : true)
  }, [pending, settle, value, blocked])

  // Focus the input (prompt) when a dialog opens.
  useEffect(() => {
    if (pending?.kind === 'prompt') {
      const id = setTimeout(() => inputRef.current?.focus(), 20)
      return () => clearTimeout(id)
    }
  }, [pending])

  // Escape cancels; Enter confirms (single-line prompt / confirm).
  useEffect(() => {
    if (!pending) return
    const multiline = pending.kind === 'prompt' && pending.opts.multiline === true
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape')                 { e.preventDefault(); cancel() }
      else if (e.key === 'Enter' && !multiline) { e.preventDefault(); accept() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, cancel, accept])

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}

      <AnimatePresence>
        {pending && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
              onClick={cancel} aria-hidden
            />
            <motion.div
              ref={trapRef}
              role="dialog" aria-modal="true" aria-labelledby="confirm-title"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0,  scale: 1    }}
              exit={{    opacity: 0, y: 8,  scale: 0.98 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
            >
              <div className="flex items-start gap-3 p-5">
                {danger && (
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10" aria-hidden>
                    <AlertTriangle className="size-[18px] text-destructive" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2 id="confirm-title" className="text-[15px] font-bold text-foreground">
                    {pending.opts.title ?? (isPrompt ? 'Enter a value' : 'Are you sure?')}
                  </h2>
                  <p className="mt-1 whitespace-pre-line text-[13.5px] leading-relaxed text-muted-foreground">
                    {pending.opts.message}
                  </p>

                  {isPrompt && (
                    (pending as { opts: PromptOptions }).opts.multiline
                      ? (
                        <textarea
                          ref={el => { inputRef.current = el }}
                          value={value}
                          onChange={e => setValue(e.target.value)}
                          placeholder={(pending as { opts: PromptOptions }).opts.placeholder}
                          rows={3}
                          className="mt-3 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        />
                      )
                      : (
                        <input
                          ref={el => { inputRef.current = el }}
                          value={value}
                          onChange={e => setValue(e.target.value)}
                          placeholder={(pending as { opts: PromptOptions }).opts.placeholder}
                          className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        />
                      )
                  )}
                </div>
                <button
                  type="button" onClick={cancel} aria-label="Close"
                  className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
                <button
                  type="button" onClick={cancel}
                  className="rounded-lg border border-border px-3.5 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  {pending.opts.cancelLabel ?? 'Cancel'}
                </button>
                <button
                  type="button" onClick={accept} disabled={blocked}
                  className={cn(
                    'rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    danger ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90',
                  )}
                >
                  {pending.opts.confirmLabel ?? (isPrompt ? 'Submit' : 'Confirm')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  )
}
