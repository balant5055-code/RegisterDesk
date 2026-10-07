'use client'

// RD-RACEOPS-02C · Stage 3 — Prepare & upload.
//
// The organizer must never have to guess what file to prepare. Three ways in, in the
// order we recommend them, then the facts about the file, then the dropzone:
//
//   1. Download the START LIST — this race's participants with their bibs already in
//      place; fill the result columns and upload. Recommended.
//   2. Download the empty RESULTS TEMPLATE (XLSX or CSV) — the same columns, no rows.
//   3. Upload a TIMING-SYSTEM EXPORT as it comes; columns are mapped in the next step.
//
// Every fact shown here is read from the canonical result model (RESULT_FIELDS,
// REQUIRED_RESULT_FIELDS, the parser's constants) — nothing is a hand-typed field list, so
// this panel cannot describe a contract the parser does not enforce.
//
// Downloads go through the authorised API (the files are per race and per workspace) and
// are saved from a Blob, exactly as the results export already does.

import { useCallback, useId, useState, type ReactNode } from 'react'
import { Download, FileSpreadsheet, ListChecks, Upload } from 'lucide-react'
import { Banner } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { RESULT_FIELDS } from '@/features/race-operations/types/results'
import {
  formatAcceptedExtensions, formatMaxFileSize, RESULTS_MAX_ROWS,
} from '@/features/race-operations/import/constants'

export interface PrepareUploadPanelProps {
  eventId:   string
  passId:    string
  raceName:  string
  /** The dropzone, rendered below the guidance so the page reads top-down. */
  children:  ReactNode
}

type DownloadKind = 'start-list' | 'template-xlsx' | 'template-csv'

const API = '/api/organizer/race-operations/races'

export function PrepareUploadPanel({ eventId, passId, raceName, children }: PrepareUploadPanelProps) {
  const { getToken } = useAuth()
  const [busy,  setBusy]  = useState<DownloadKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  const download = useCallback(async (kind: DownloadKind) => {
    setBusy(kind); setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Your session has expired. Please sign in again.')
      const qs = new URLSearchParams({ eventId, passId })
      const path = kind === 'start-list'
        ? `${API}/start-list?${qs}&format=xlsx`
        : `${API}/template?${qs}&format=${kind === 'template-csv' ? 'csv' : 'xlsx'}`
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? 'The file could not be prepared. Please try again.')
      }
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${kind}.${kind === 'template-csv' ? 'csv' : 'xlsx'}`
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = Object.assign(document.createElement('a'), { href: url, download: name })
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The file could not be prepared.')
    } finally {
      setBusy(null)
    }
  }, [eventId, passId, getToken])

  const required = RESULT_FIELDS.filter(f => f.required)
  const optional = RESULT_FIELDS.filter(f => !f.required)

  return (
    <div className="space-y-4">
      {/* ── The three ways in ─────────────────────────────────────────────── */}
      <div className="grid gap-3 md:grid-cols-3">
        <Option
          icon={ListChecks}
          eyebrow="Recommended"
          title="Download start list"
          description={`This race's participants with their bibs already filled in. Add each result and upload the file. The workbook also has an optional Splits sheet for checkpoint times.`}
          actions={
            <ActionButton primary busy={busy === 'start-list'} disabled={busy !== null} onClick={() => void download('start-list')}>
              <Download className="size-4" aria-hidden /> Start list (XLSX)
            </ActionButton>
          }
        />
        <Option
          icon={FileSpreadsheet}
          title="Download results template"
          description="The supported columns with no rows. Fill in one row per bib and upload the completed file. Checkpoint times need the XLSX — a CSV holds one sheet."
          actions={
            <>
              <ActionButton busy={busy === 'template-xlsx'} disabled={busy !== null} onClick={() => void download('template-xlsx')}>
                <Download className="size-4" aria-hidden /> XLSX
              </ActionButton>
              <ActionButton busy={busy === 'template-csv'} disabled={busy !== null} onClick={() => void download('template-csv')}>
                <Download className="size-4" aria-hidden /> CSV
              </ActionButton>
            </>
          }
        />
        <Option
          icon={Upload}
          title="Upload a timing-system export"
          description="Upload your timing provider's CSV, XLSX or text-based PDF as it comes. You map its columns in the next step — no RegisterDesk format needed. Scanned or photographed results cannot be read."
        />
      </div>

      {error && (
        <Banner tone="error" title="The file could not be prepared">
          <span id={errorId}>{error}</span>
        </Banner>
      )}

      {/* ── What the file must contain — from the canonical model ─────────── */}
      <div className="rounded-xl border border-border bg-card px-4 py-3.5">
        <dl className="grid gap-x-6 gap-y-2 text-fs-sm sm:grid-cols-[auto_1fr]">
          <dt className="font-medium text-foreground">Supported files</dt>
          <dd className="text-muted-foreground">
            {formatAcceptedExtensions()} · up to {formatMaxFileSize()} · up to{' '}
            {RESULTS_MAX_ROWS.toLocaleString('en-IN')} rows · one file for <span className="font-medium text-foreground">{raceName}</span> only
          </dd>
          <dt className="font-medium text-foreground">Required columns</dt>
          <dd className="text-muted-foreground">
            {required.map((f, i) => (
              <span key={f.field}>
                {i > 0 && ', '}
                <span className="font-medium text-foreground">{f.label}</span>
                {' — '}{f.description.replace(/ Required.*$/, '').replace(/\.$/, '')}
              </span>
            ))}
          </dd>
          <dt className="font-medium text-foreground">Optional columns</dt>
          <dd className="text-muted-foreground">{optional.map(f => f.label).join(', ')}</dd>
          <dt className="font-medium text-foreground">Chip / Net Time</dt>
          <dd className="text-muted-foreground">
            The participant&apos;s elapsed result from the timing system — the time RegisterDesk ranks by.
            hh:mm:ss, e.g. 01:48:32.
          </dd>
          <dt className="font-medium text-foreground">Gun / Gross / Finish Time</dt>
          <dd className="text-muted-foreground">
            Start-to-finish clock time, when your timing system supplies one. Shown beside the chip time, never used for ranking.
          </dd>
          <dt className="font-medium text-foreground">Status</dt>
          <dd className="text-muted-foreground">
            Finished (assumed when a time is present), DNF, DNS or DQ. Position is calculated by RegisterDesk — a rank column in your file is ignored.
          </dd>
        </dl>
      </div>

      {children}
    </div>
  )
}

function Option({ icon: Icon, eyebrow, title, description, actions }: {
  icon: typeof Download; eyebrow?: string; title: string; description: string; actions?: ReactNode
}) {
  return (
    <div className={cn(
      'flex flex-col gap-3 rounded-xl border bg-card p-4',
      eyebrow ? 'border-primary/40' : 'border-border',
    )}>
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-fs-2xs font-semibold uppercase tracking-wide text-primary">{eyebrow}</p>
          )}
          <h3 className="text-fs-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      {actions && <div className="mt-auto flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

function ActionButton({ primary, busy, disabled, onClick, children }: {
  primary?: boolean; busy: boolean; disabled: boolean; onClick: () => void; children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      className={cn(
        'inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-fs-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60',
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-border bg-card text-foreground hover:bg-muted',
      )}
    >
      {busy ? 'Preparing…' : children}
    </button>
  )
}
