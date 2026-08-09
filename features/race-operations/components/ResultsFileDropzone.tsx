'use client'

// RD-RACEOPS-01 Sprint 2 · Results file upload control.
//
// Why this is built rather than reused: the Phase 0 audit found NO shared upload
// component in the codebase — every upload site hand-rolls its own input
// (ImportParticipantsDrawer.tsx, BrandingMediaSection.tsx, TemplatesPanel.tsx,
// PropertiesPanel.tsx, Step3View.tsx). Extracting a shared one would mean editing five
// production files, which this sprint forbids. So Race Operations builds exactly ONE
// dropzone and every upload in the module uses it.
//
// Everything visual comes from the existing token layer and primitives — no new colours,
// no new spacing scale.

import { useCallback, useId, useRef, useState } from 'react'
import { FileSpreadsheet, Loader2, Upload, X } from 'lucide-react'
import { Banner, Card } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  RESULTS_ACCEPTED_EXTENSIONS, RESULTS_FILE_ACCEPT, formatMaxFileSize,
} from '@/features/race-operations/import'

export interface ResultsFileDropzoneProps {
  onFileSelected: (file: File) => void
  busy:           boolean
  fileName:       string | null
  fileSize:       number
  error:          string | null
  onClear:        () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ResultsFileDropzone({
  onFileSelected, busy, fileName, fileSize, error, onClear,
}: ResultsFileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId  = useId()
  const hintId   = useId()
  const [dragging, setDragging] = useState(false)

  const take = useCallback((files: FileList | null) => {
    const file = files?.[0]
    if (file) onFileSelected(file)
  }, [onFileSelected])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!busy) take(e.dataTransfer.files)
  }, [busy, take])

  return (
    <div className="space-y-3">
      <Card padded={false}>
        <div
          onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-xl border-2 border-dashed p-6 text-center transition-colors',
            dragging ? 'border-primary/60 bg-primary/[0.04]' : 'border-border',
            busy && 'opacity-70',
          )}
        >
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={RESULTS_FILE_ACCEPT}
            className="sr-only"
            disabled={busy}
            aria-describedby={hintId}
            onChange={e => { take(e.target.files); e.target.value = '' }}
          />

          <div
            className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted"
            aria-hidden
          >
            {busy
              ? <Loader2 className="size-5 animate-spin text-muted-foreground" />
              : <Upload className="size-5 text-muted-foreground" />}
          </div>

          <p className="mt-3 text-fs-md font-semibold text-foreground">
            {busy ? 'Reading your file…' : 'Upload your results file'}
          </p>

          <p id={hintId} className="mx-auto mt-1 max-w-sm text-fs-sm leading-relaxed text-muted-foreground">
            Drag a file here, or choose one below. {RESULTS_ACCEPTED_EXTENSIONS.join(' and ')} up
            to {formatMaxFileSize()}. Export it from your timing system exactly as it comes —
            you will map the columns in the next step.
          </p>

          <label
            htmlFor={inputId}
            className={cn(
              'mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2',
              'text-fs-sm font-medium text-foreground transition-colors hover:bg-muted',
              'focus-within:ring-2 focus-within:ring-primary',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <FileSpreadsheet className="size-4" aria-hidden />
            Choose file
          </label>
        </div>
      </Card>

      {fileName && !error && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-fs-base font-medium text-foreground">{fileName}</p>
            <p className="text-fs-sm text-muted-foreground">{formatBytes(fileSize)}</p>
          </div>
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            aria-label={`Remove ${fileName}`}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      {error && (
        <Banner tone="error" title="This file could not be read">
          {error}
        </Banner>
      )}
    </div>
  )
}
