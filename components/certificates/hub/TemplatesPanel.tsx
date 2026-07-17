'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Upload, Loader2, Pencil, Trash2, CheckCircle2, PenSquare, FileText, Copy, Star, LayoutTemplate } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { uploadCertificateTemplate } from '@/lib/firebase/storage'
import { cn } from '@/lib/utils/cn'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Spinner, ErrorBox, Badge, btnGhost } from './ui'
import GlobalTemplatesModal from './GlobalTemplatesModal'
import { useToast } from '@/components/ui/Toast'
import type { CertApi } from './api'
import type { SerializedCertificateTemplateDoc, TemplateType } from '@/lib/certificates/types'

// GA-8 P1-3: the Global Template Library has no admin publishing surface in v1.0, so
// the organizer catalog is always empty. Rather than advertise a dead "Start from
// Library" flow, it is withheld from v1.0. Flip to true once an admin can publish
// global templates (the organizer import path + modal are already wired).
const GLOBAL_TEMPLATE_LIBRARY_ENABLED = false

function typeFromFile(file: File): TemplateType | null {
  const n = file.name.toLowerCase()
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (file.type === 'image/png' || n.endsWith('.png')) return 'png'
  if (file.type === 'image/jpeg' || n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'jpg'
  return null
}

export default function TemplatesPanel({ api, eventId }: { api: CertApi; eventId: string }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [templates, setTemplates] = useState<SerializedCertificateTemplateDoc[]>([])
  const [uploading, setUploading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const { confirm, prompt } = useConfirm()
  const { showToast } = useToast()

  const load = useCallback(() => {
    setErr(null)
    return api.getTemplates().then(r => setTemplates(r.templates)).catch(e => setErr(e.message))
  }, [api])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const templateType = typeFromFile(file)
    if (!templateType) { setErr('Unsupported file. Upload a PDF, PNG, or JPG.'); return }
    const uid = auth.currentUser?.uid
    if (!uid) { setErr('Not authenticated.'); return }
    setUploading(true); setErr(null)
    try {
      const fileUrl = await uploadCertificateTemplate(uid, eventId, file)
      await api.createTemplate({ name: file.name.replace(/\.[^.]+$/, ''), templateType, fileUrl, fileName: file.name })
      await load()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Upload failed')
    } finally { setUploading(false) }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id); setErr(null)
    try { await fn(); await load() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') }
    finally { setBusyId(null) }
  }

  if (loading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-[200px] flex-1 text-[13px] text-muted-foreground">{GLOBAL_TEMPLATE_LIBRARY_ENABLED ? 'Start from the template library or upload your own (PDF, PNG, or JPG), then design it in the builder.' : 'Upload your own template (PDF, PNG, or JPG), then design it in the builder.'} One template can be active at a time.</p>
        <div className="flex shrink-0 items-center gap-2">
          {GLOBAL_TEMPLATE_LIBRARY_ENABLED && (
            <button type="button" className={btnGhost} onClick={() => setShowLibrary(true)}>
              <LayoutTemplate className="size-4" /> Start from Library
            </button>
          )}
          <button type="button" className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}{uploading ? 'Uploading…' : 'Upload Template'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={onFile} />
      </div>

      {GLOBAL_TEMPLATE_LIBRARY_ENABLED && (
        <GlobalTemplatesModal api={api} open={showLibrary} onClose={() => setShowLibrary(false)} onImported={name => { showToast(`Imported "${name}" — customise it in the builder.`, 'success'); void load() }} />
      )}

      {err && <ErrorBox message={err} />}

      {templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-14 text-center">
          <FileText className="size-8 text-muted-foreground/40" />
          <p className="text-[14px] font-medium text-foreground">No templates yet</p>
          <p className="text-[13px] text-muted-foreground">Upload a PDF, PNG, or JPG to get started.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map(t => (
            <div key={t.templateId} className={cn('rounded-xl border bg-card p-4', t.isActive ? 'border-primary' : 'border-border')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {t.favorite && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Favorite" />}
                    <p className="truncate text-[14px] font-semibold text-foreground">{t.name}</p>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="gray">{t.templateType.toUpperCase()}</Badge>
                    {t.isActive && <Badge tone="green">Active</Badge>}
                    {t.status === 'draft' && <Badge tone="amber">Draft</Badge>}
                    {t.status === 'archived' && <Badge tone="gray">Archived</Badge>}
                    {t.category && <Badge tone="blue">{t.category}</Badge>}
                  </div>
                </div>
              </div>
              {t.dimensions && <p className="mt-2 text-[12px] text-muted-foreground">{t.dimensions.width}×{t.dimensions.height} {t.dimensions.unit}{t.pageCount ? ` · ${t.pageCount}p` : ''}{(t.usageCount ?? 0) > 0 ? ` · used ${t.usageCount}×` : ''}</p>}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Link href={`/dashboard/events/${eventId}/certificates/builder/${t.templateId}`} className={btnGhost}><PenSquare className="size-3.5" /> Builder</Link>
                {!t.isActive && (
                  <button type="button" className={btnGhost} disabled={busyId === t.templateId} onClick={() => act(t.templateId, () => api.patchTemplate(t.templateId, { isActive: true }))}>
                    <CheckCircle2 className="size-3.5" /> Activate
                  </button>
                )}
                <button type="button" className={btnGhost} title={t.favorite ? 'Unfavorite' : 'Favorite'} disabled={busyId === t.templateId} onClick={() => act(t.templateId, () => api.patchTemplateMeta(t.templateId, { favorite: !t.favorite }))}>
                  <Star className={cn('size-3.5', t.favorite && 'fill-amber-400 text-amber-400')} />
                </button>
                <button type="button" className={btnGhost} disabled={busyId === t.templateId} onClick={() => act(t.templateId, () => api.duplicateTemplate(t.templateId))}>
                  <Copy className="size-3.5" /> Duplicate
                </button>
                <button type="button" className={btnGhost} disabled={busyId === t.templateId} onClick={async () => {
                  const name = (await prompt({ message: 'Rename template', defaultValue: t.name }))?.trim()
                  if (name) act(t.templateId, () => api.patchTemplate(t.templateId, { name }))
                }}><Pencil className="size-3.5" /> Rename</button>
                <button type="button" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')} disabled={busyId === t.templateId} onClick={async () => {
                  if (await confirm({ message: `Delete "${t.name}"? This cannot be undone.`, tone: 'danger' })) act(t.templateId, () => api.deleteTemplate(t.templateId))
                }}><Trash2 className="size-3.5" /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
