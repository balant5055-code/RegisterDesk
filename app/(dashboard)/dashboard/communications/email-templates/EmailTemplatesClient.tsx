'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  TEMPLATE_KEYS,
  TEMPLATE_META,
  TEMPLATE_VARIABLES,
  SAMPLE_VARS,
  substituteVariables,
} from '@/lib/email-templates/types'
import { getAllDefaultTemplates } from '@/lib/email-templates/defaults'
import type { TemplateKey, EmailTemplateRecord } from '@/lib/email-templates/types'
import {
  Bold, Italic, Underline, Link2, List, RotateCcw, Save,
  ChevronDown, CheckCircle2, AlertCircle, Loader2, Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { PageHeader } from '@/components/ui'
import { useConfirm } from '@/components/ui/ConfirmDialog'

// ─── Types ────────────────────────────────────────────────────────────────────

type LoadState = 'idle' | 'loading' | 'loaded' | 'error'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// ─── Email preview shell ──────────────────────────────────────────────────────

function buildPreviewHtml(subject: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject.replace(/</g, '&lt;')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px 12px}
  .shell{max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .header{background:linear-gradient(135deg,#e5277e,#c01f68);padding:24px 32px}
  .header-logo{color:#fff;font-size:16px;font-weight:800;letter-spacing:.08em}
  .body{padding:28px 32px}
  .footer{padding:18px 32px;border-top:1px solid #f3f4f6;text-align:center}
  .footer p{font-size:11px;color:#9ca3af;line-height:1.6}
</style>
</head><body>
<div class="shell">
  <div class="header"><span class="header-logo">RegisterDesk</span></div>
  <div class="body">${body}</div>
  <div class="footer">
    <p>You are receiving this email because you registered via RegisterDesk.<br>
    &copy; ${new Date().getFullYear()} RegisterDesk. All rights reserved.</p>
  </div>
</div>
</body></html>`
}

// ─── Formatting toolbar helpers ───────────────────────────────────────────────

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  onChange: (val: string) => void,
) {
  const { selectionStart: ss, selectionEnd: se, value } = textarea
  const selected = value.slice(ss, se)
  const replacement = selected ? `${before}${selected}${after}` : `${before}placeholder${after}`
  const next = value.slice(0, ss) + replacement + value.slice(se)
  onChange(next)
  requestAnimationFrame(() => {
    textarea.focus()
    const newEnd = ss + replacement.length
    textarea.setSelectionRange(ss, newEnd)
  })
}

function insertAtCursor(
  textarea: HTMLTextAreaElement,
  text: string,
  onChange: (val: string) => void,
) {
  const { selectionStart: ss, value } = textarea
  const next = value.slice(0, ss) + text + value.slice(ss)
  onChange(next)
  requestAnimationFrame(() => {
    textarea.focus()
    textarea.setSelectionRange(ss + text.length, ss + text.length)
  })
}

// ─── Template selector ────────────────────────────────────────────────────────

function TemplateSelector({
  selected,
  records,
  onSelect,
}: {
  selected:  TemplateKey
  records:   Partial<Record<TemplateKey, EmailTemplateRecord>>
  onSelect:  (key: TemplateKey) => void
}) {
  return (
    <ul className="space-y-1" role="listbox" aria-label="Email templates">
      {TEMPLATE_KEYS.map(key => {
        const meta   = TEMPLATE_META[key]
        const rec    = records[key]
        const active = key === selected
        return (
          <li key={key} role="option" aria-selected={active}>
            <button
              type="button"
              onClick={() => onSelect(key)}
              className={cn(
                'w-full rounded-xl px-3 py-2.5 text-left transition-all duration-150',
                active
                  ? 'bg-primary/[0.08] ring-1 ring-primary/20'
                  : 'hover:bg-muted/60',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className={cn('text-[13.5px] font-semibold', active ? 'text-primary' : 'text-foreground')}>
                  {meta.label}
                </p>
                {rec?.isCustomized && (
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                    Custom
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{meta.trigger}</p>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Variables chip bar ───────────────────────────────────────────────────────

function VariableChips({ onInsert }: { onInsert: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        Insert Variable
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TEMPLATE_VARIABLES.map(v => (
            <button
              key={v.key}
              type="button"
              title={v.description}
              onClick={() => { onInsert(v.name); setOpen(false) }}
              className="rounded-lg border border-border bg-muted/40 px-2 py-0.5 font-mono text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary"
            >
              {v.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Formatting toolbar ───────────────────────────────────────────────────────

function FormattingToolbar({
  textareaRef,
  onChange,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onChange:    (val: string) => void
}) {
  function btn(label: string, Icon: React.ElementType, action: () => void) {
    return (
      <button
        key={label}
        type="button"
        title={label}
        onMouseDown={e => { e.preventDefault(); action() }}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
    )
  }

  const ta = () => textareaRef.current!
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/30 p-1">
      {btn('Bold',      Bold,      () => wrapSelection(ta(), '<strong>', '</strong>', onChange))}
      {btn('Italic',    Italic,    () => wrapSelection(ta(), '<em>', '</em>', onChange))}
      {btn('Underline', Underline, () => wrapSelection(ta(), '<u>', '</u>', onChange))}
      <div className="mx-1 h-4 w-px bg-border" />
      {btn('Link',      Link2,     () => wrapSelection(ta(), '<a href="URL">', '</a>', onChange))}
      {btn('List item', List,      () => wrapSelection(ta(), '<li>', '</li>', onChange))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function EmailTemplatesClient() {
  const { confirm } = useConfirm()
  const [loadState,    setLoadState]    = useState<LoadState>('idle')
  const [saveState,    setSaveState]    = useState<SaveState>('idle')
  const [saveError,    setSaveError]    = useState<string | null>(null)
  const [records,      setRecords]      = useState<Partial<Record<TemplateKey, EmailTemplateRecord>>>({})
  const [selectedKey,  setSelectedKey]  = useState<TemplateKey>('registration_submitted')
  const [subject,      setSubject]      = useState('')
  const [body,         setBody]         = useState('')
  const [activeTab,    setActiveTab]    = useState<'edit' | 'preview'>('edit')
  const [isDirty,      setIsDirty]      = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const defaults    = getAllDefaultTemplates()

  // ── Load templates ──────────────────────────────────────────────────────────
  const loadTemplates = useCallback(async () => {
    setLoadState('loading')
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setLoadState('error'); return }
      const res  = await fetch('/api/organizer/email-templates', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as { success: boolean; templates?: Record<TemplateKey, EmailTemplateRecord>; error?: string }
      if (!data.success || !data.templates) { setLoadState('error'); return }
      setRecords(data.templates)
      setLoadState('loaded')
    } catch {
      setLoadState('error')
    }
  }, [])

  useEffect(() => { void loadTemplates() }, [loadTemplates])

  // ── Sync editor when key or records change ──────────────────────────────────
  useEffect(() => {
    const rec = records[selectedKey]
    if (rec) {
      setSubject(rec.subject)
      setBody(rec.body)
    } else {
      const def = defaults[selectedKey]
      setSubject(def.subject)
      setBody(def.body)
    }
    setIsDirty(false)
    setSaveState('idle')
    setSaveError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, records])

  function handleBodyChange(val: string) {
    setBody(val)
    setIsDirty(true)
    if (saveState === 'saved') setSaveState('idle')
  }

  function handleSubjectChange(val: string) {
    setSubject(val)
    setIsDirty(true)
    if (saveState === 'saved') setSaveState('idle')
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaveState('saving')
    setSaveError(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setSaveError('Not authenticated'); setSaveState('error'); return }
      const res = await fetch('/api/organizer/email-templates', {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ key: selectedKey, subject, bodyHtml: body }),
      })
      const data = await res.json() as { success: boolean; error?: string }
      if (!data.success) { setSaveError(data.error ?? 'Save failed'); setSaveState('error'); return }
      setSaveState('saved')
      setIsDirty(false)
      setRecords(prev => ({
        ...prev,
        [selectedKey]: {
          key: selectedKey, subject, body,
          isCustomized: true,
          updatedAt:    new Date().toISOString(),
        },
      }))
    } catch {
      setSaveError('Network error. Please try again.')
      setSaveState('error')
    }
  }

  // ── Reset to default ────────────────────────────────────────────────────────
  async function handleReset() {
    if (!(await confirm({ message: 'Reset to platform default? Your custom version will be deleted.', tone: 'danger' }))) return
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const res = await fetch(`/api/organizer/email-templates/${selectedKey}`, {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as { success: boolean }
      if (data.success) {
        setRecords(prev => {
          const next = { ...prev }
          const def = defaults[selectedKey]
          next[selectedKey] = { ...def, isCustomized: false, updatedAt: null }
          return next
        })
        setSaveState('idle')
        setIsDirty(false)
        setSaveError(null)
      }
    } catch { /* silent */ }
  }

  // ── Variable insert into body ───────────────────────────────────────────────
  function handleInsertVariable(variable: string) {
    if (textareaRef.current) {
      insertAtCursor(textareaRef.current, variable, handleBodyChange)
    } else {
      setBody(prev => prev + variable)
      setIsDirty(true)
    }
  }

  // ── Preview rendering ───────────────────────────────────────────────────────
  const previewSubject = substituteVariables(subject, SAMPLE_VARS)
  const previewBody    = substituteVariables(body,    SAMPLE_VARS, { escapeValues: true })
  const previewHtml    = buildPreviewHtml(previewSubject, previewBody)

  const currentRec  = records[selectedKey]
  const meta        = TEMPLATE_META[selectedKey]

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col gap-6">

      {/* ── Page header ── */}
      <PageHeader
        title="Email Templates"
        subtitle="Customize emails sent to attendees. Changes apply to all future registrations."
      />

      {/* ── Loading / error states ── */}
      {loadState === 'loading' && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <p className="text-[14px] text-muted-foreground">Loading templates…</p>
        </div>
      )}
      {loadState === 'error' && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.05] px-5 py-4">
          <AlertCircle className="size-4 text-destructive" />
          <p className="text-[14px] text-destructive">Failed to load templates. <button onClick={() => void loadTemplates()} className="underline">Retry</button></p>
        </div>
      )}

      {loadState === 'loaded' && (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">

          {/* ── Left: template selector ── */}
          <aside className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="mb-2 px-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                Templates
              </p>
              <TemplateSelector
                selected={selectedKey}
                records={records}
                onSelect={async key => {
                  if (isDirty && !(await confirm({ message: 'Discard unsaved changes?', tone: 'danger' }))) return
                  setSelectedKey(key)
                }}
              />
            </div>

            {/* Variable reference (desktop) */}
            <div className="hidden rounded-2xl border border-border bg-card p-4 lg:block">
              <p className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                Available Variables
              </p>
              <div className="space-y-2">
                {TEMPLATE_VARIABLES.map(v => (
                  <div key={v.key} className="flex items-start gap-2">
                    <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
                      {v.name}
                    </code>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">{v.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </aside>

          {/* ── Right: editor + preview ── */}
          <section className="flex flex-col gap-4">

            {/* Template meta bar */}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/20 px-4 py-3">
              <div>
                <p className="text-[14.5px] font-semibold text-foreground">{meta.label}</p>
                <p className="text-[12.5px] text-muted-foreground">{meta.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {currentRec?.isCustomized && (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
                    Customized
                  </span>
                )}
                {currentRec?.updatedAt && (
                  <span className="text-[12px] text-muted-foreground">
                    Saved {new Date(currentRec.updatedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>

            {/* Edit / Preview tabs */}
            <div className="flex gap-1 rounded-xl border border-border bg-muted/30 p-1 self-start">
              {(['edit', 'preview'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-all',
                    activeTab === tab
                      ? 'bg-card shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab === 'preview' && <Eye className="size-3.5" />}
                  {tab}
                </button>
              ))}
            </div>

            {activeTab === 'edit' && (
              <div className="rounded-2xl border border-border bg-card">
                <div className="space-y-4 p-5">

                  {/* Subject */}
                  <div className="space-y-1.5">
                    <label htmlFor="email-subject" className="block text-[13px] font-semibold text-foreground">
                      Subject Line
                    </label>
                    <input
                      id="email-subject"
                      type="text"
                      value={subject}
                      onChange={e => handleSubjectChange(e.target.value)}
                      placeholder="Email subject…"
                      className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>

                  {/* Body */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="email-body" className="block text-[13px] font-semibold text-foreground">
                        Email Body
                        <span className="ml-1.5 font-normal text-muted-foreground">(HTML)</span>
                      </label>
                      <FormattingToolbar textareaRef={textareaRef} onChange={handleBodyChange} />
                    </div>
                    <textarea
                      id="email-body"
                      ref={textareaRef}
                      value={body}
                      onChange={e => handleBodyChange(e.target.value)}
                      rows={14}
                      spellCheck={false}
                      className="w-full resize-y rounded-xl border border-border bg-background px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                      placeholder="Enter email body HTML…"
                    />
                    <VariableChips onInsert={handleInsertVariable} />
                  </div>

                </div>

                {/* Action bar */}
                <div className="flex items-center justify-between gap-3 rounded-b-2xl border-t border-border bg-muted/20 px-5 py-3">
                  <div>
                    {saveState === 'saved' && (
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-600">
                        <CheckCircle2 className="size-4" /> Saved
                      </span>
                    )}
                    {saveState === 'error' && saveError && (
                      <span className="flex items-center gap-1.5 text-[13px] text-destructive">
                        <AlertCircle className="size-4" /> {saveError}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {currentRec?.isCustomized && (
                      <button
                        type="button"
                        onClick={() => void handleReset()}
                        className="flex items-center gap-2 rounded-xl border border-border bg-background px-3.5 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                      >
                        <RotateCcw className="size-3.5" />
                        Reset to Default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleSave()}
                      disabled={saveState === 'saving' || !isDirty}
                      className={cn(
                        'flex items-center gap-2 rounded-xl px-4 py-2 text-[13.5px] font-semibold transition-all',
                        isDirty && saveState !== 'saving'
                          ? 'bg-primary text-primary-foreground hover:opacity-90'
                          : 'cursor-not-allowed bg-muted text-muted-foreground',
                      )}
                    >
                      {saveState === 'saving'
                        ? <><Loader2 className="size-3.5 animate-spin" /> Saving…</>
                        : <><Save className="size-3.5" /> Save Template</>
                      }
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'preview' && (
              <div className="rounded-2xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/60">
                      Preview — sample data
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium text-foreground">{previewSubject}</p>
                  </div>
                </div>
                <div className="overflow-hidden rounded-b-2xl bg-[#f3f4f6]">
                  <iframe
                    srcDoc={previewHtml}
                    title="Email preview"
                    className="h-[600px] w-full border-0"
                    sandbox="allow-same-origin"
                  />
                </div>
              </div>
            )}

          </section>
        </div>
      )}

    </div>
  )
}
