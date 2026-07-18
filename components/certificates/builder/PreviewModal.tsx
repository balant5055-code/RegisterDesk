'use client'

import { useEffect, useState } from 'react'
import { Loader2, X, AlertCircle, ExternalLink } from 'lucide-react'
import { IconButton } from '@/components/ui'
import type { CertificateLayout } from '@/lib/certificates/types'

interface Props {
  eventId:    string
  templateId: string
  token:      string
  layout:     CertificateLayout
  onClose:    () => void
}

/** Renders the authoritative server preview (real renderer) for the UNSAVED layout. */
export default function PreviewModal({ eventId, templateId, token, layout, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/organizer/events/${eventId}/certificates/templates/${templateId}/preview`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ layout }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: string } | null
          throw new Error(body?.error ?? `Preview failed (${res.status})`)
        }
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Preview failed')
      }
    })()
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [eventId, templateId, token, layout])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-[14px] font-semibold text-foreground">Server Preview</h3>
          <div className="flex items-center gap-1">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted"
              >
                <ExternalLink className="size-3.5" /> Open in new tab
              </a>
            )}
            <IconButton type="button" onClick={onClose}><X className="size-4" /></IconButton>
          </div>
        </div>
        <div className="relative flex-1 bg-muted/40">
          {!url && !err && (
            <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
          )}
          {err && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-red-600">
              <AlertCircle className="size-6" /><p className="text-[13px]">{err}</p>
            </div>
          )}
          {url && <iframe src={url} title="Certificate preview" className="h-full w-full" />}
        </div>
      </div>
    </div>
  )
}
