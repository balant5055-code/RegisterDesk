'use client'

// RD-RACEOPS-01 Sprint 3 · Organizer review + publish (Step 5 → Step 6).
//
// What the organizer sees before publishing: import statistics, warnings/errors, the
// ranking outcome, and the session's own provenance. Publish is only offered once ranking
// has completed — the same precondition the server enforces, shown rather than merely
// enforced.
//
// Composed from the existing primitives; no new visual language.

import { useState } from 'react'
import {
  AlertCircle, AlertTriangle, CheckCircle2, Database, Loader2, Medal, Send, Trophy, XCircle,
} from 'lucide-react'
import { Banner, Button, Card, StatusChip } from '@/components/ui'
import { useConfirm } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { IMPORT_SESSION_STATUS_LABEL, type ImportSessionView } from '@/features/race-operations/types/session'
import type { CommitPhase, CommitProgress } from '@/features/race-operations/hooks/useSessionCommit'
import type { VerifyResponse } from '@/app/api/organizer/race-operations/sessions/[sessionId]/verify/route'

const STATUS_TONE = {
  draft:     'warning',
  published: 'success',
  cancelled: 'danger',
} as const

interface StatProps { label: string; value: string; icon: typeof Database }

function Stat({ label, value, icon: Icon }: StatProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-[17px] font-bold leading-none text-foreground">{value}</p>
        <p className="mt-0.5 text-fs-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export interface SessionReviewPanelProps {
  phase:     CommitPhase
  session:   ImportSessionView
  progress:  CommitProgress
  error:     string | null
  /** RD-RESULTS-CLOSURE-01 · start-list result. Null until verification has run. */
  verification: VerifyResponse | null
  onPublish: () => void
  onCancel:  (reason?: string) => void
}

const n = (v: number) => v.toLocaleString('en-IN')

export function SessionReviewPanel({
  phase, session, progress, error, verification, onPublish, onCancel,
}: SessionReviewPanelProps) {
  const { confirm } = useConfirm()
  const [busy, setBusy] = useState(false)

  // RD-RESULTS-CLOSURE-01 · publish is refused server-side while either count is non-zero.
  // Derived here too so the button is disabled rather than failing on click — the server
  // stays the authority; this only stops the organizer discovering it the hard way.
  const blocking = verification !== null
    && (verification.unknownRunner > 0 || verification.wrongRace > 0)

  const ranked      = session.rankedAt !== null
  const isPublished = session.status === 'published'
  const isCancelled = session.status === 'cancelled'
  const canAct      = phase === 'review' && !isPublished && !isCancelled

  async function handlePublish() {
    const ok = await confirm({
      title: 'Publish these results?',
      message: `${n(session.storedRows)} results for ${session.passName} will be marked published. `
        + 'This cannot be undone in this release — cancel the import instead if you are unsure.',
      confirmLabel: 'Publish results',
    })
    if (!ok) return
    setBusy(true)
    try { onPublish() } finally { setBusy(false) }
  }

  async function handleCancel() {
    const ok = await confirm({
      title: 'Cancel this import?',
      message: 'The imported rows are kept for your records but will never be published. '
        + 'You can upload a corrected file afterwards.',
      confirmLabel: 'Cancel import',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try { onCancel() } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {/* ── Provenance ── */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-fs-md font-semibold text-foreground">Import session</h3>
              <StatusChip tone={STATUS_TONE[session.status]}>
                {IMPORT_SESSION_STATUS_LABEL[session.status]}
              </StatusChip>
              {ranked && !isCancelled && <StatusChip tone="info">Ranked</StatusChip>}
            </div>
            <p className="mt-1 truncate text-fs-sm text-muted-foreground">
              {session.fileName} · {session.passName} · via {session.provider}
            </p>
            <p className="mt-0.5 font-mono text-fs-2xs text-muted-foreground/70">
              {session.sessionId}
              {session.fileHash !== '' && ` · sha256 ${session.fileHash.slice(0, 12)}…`}
            </p>
          </div>
        </div>
      </Card>

      {/* ── Import statistics ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Rows in file"  value={n(session.totalRows)}  icon={Database} />
        <Stat label="Stored"        value={n(session.storedRows)} icon={CheckCircle2} />
        <Stat label="Ranked"        value={n(session.rankedRows)} icon={Trophy} />
        <Stat
          label={session.storedRows === session.totalRows ? 'Not stored' : 'Rejected by server'}
          value={n(Math.max(0, session.totalRows - session.storedRows))}
          icon={AlertTriangle}
        />
      </div>

      {/* ── In-flight progress ── */}
      {(phase === 'creating' || phase === 'storing' || phase === 'verifying'
        || phase === 'ranking' || phase === 'snapshotting') && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
        >
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
          <p className="text-fs-base text-foreground">
            {phase === 'creating' && 'Creating the import session…'}
            {phase === 'storing'  && `Storing results — ${n(progress.storedRows)} of ${n(progress.totalRows)}…`}
            {/* RD-RESULTS-CLOSURE-02 · verification is the longest read pass and had no
                indicator at all, so the screen simply froze on the stored-rows line. */}
            {phase === 'verifying' && `Checking ${n(progress.storedRows)} results against the start list…`}
            {phase === 'ranking'  && `Ranking finishers — ${n(progress.rankedRows)} so far…`}
            {phase === 'snapshotting' && `Preparing the public results page — ${n(progress.snapshotRows)} rows…`}
          </p>
        </div>
      )}

      {error && (
        <Banner tone="error" title="That step did not complete">{error}</Banner>
      )}

      {/* ── Outcome ── */}
      {isPublished && (
        <Banner tone="success" title="Results published">
          {n(session.storedRows)} results for {session.passName} are live on the public results
          page. There is still no unpublish — if a correction is needed, contact support before
          importing a replacement.
        </Banner>
      )}

      {isCancelled && (
        <Banner tone="warning" title="Import cancelled">
          These rows were kept for your records but will never be published.
          {session.cancelReason && ` Reason: ${session.cancelReason}`}
        </Banner>
      )}

      {/* ── Review + publish ── */}
      {canAct && (
        <Card>
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="text-fs-md font-semibold text-foreground">
                Review before publishing
              </h3>
              <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
                Results are stored as a draft and ranked. Publishing only changes this session&apos;s
                status — no data is re-imported and no row is rewritten.
              </p>
            </div>

            <ul className="space-y-1.5">
              <CheckRow ok={session.storedRows > 0}
                label={`${n(session.storedRows)} results stored as draft`} />
              <CheckRow ok={ranked}
                label={ranked
                  ? `${n(session.rankedRows)} finishers ranked (overall + race position)`
                  : 'Ranking has not finished yet'} />
              <CheckRow ok={session.errorCount === 0} warn
                label={session.errorCount === 0
                  ? 'No server-side validation errors'
                  : `${n(session.errorCount)} rows were rejected by validation and not stored`} />
            </ul>

            {/* ═══ RD-RESULTS-CLOSURE-01 · start-list summary ═══════════════
                Publishing now REFUSES while a bib on the file belongs to nobody, or belongs
                to a different race. Showing the verdict here — beside the button it gates —
                is what turns a refusal into something the organizer can act on. */}
            {verification && (
              <div className="space-y-2">
                {blocking ? (
                  <Banner tone="error" title="Fix these before publishing">
                    {verification.unknownRunner > 0 && (
                      <p>{n(verification.unknownRunner)} row(s) carry a bib that is not on this event&rsquo;s start list.</p>
                    )}
                    {verification.wrongRace > 0 && (
                      <p>{n(verification.wrongRace)} row(s) belong to a different race at this event.</p>
                    )}
                    <p className="mt-1">Correct the file and import it again.</p>
                  </Banner>
                ) : (
                  <Banner tone="success" title="Checked against the start list">
                    {n(verification.matched)} of {n(session.storedRows)} rows matched a confirmed entrant.
                    {verification.missingResult > 0 && (
                      <> {n(verification.missingResult)} entrant(s) have no row — usually a DNS, which does not block publishing.</>
                    )}
                  </Banner>
                )}
                {verification.rosterTruncated && (
                  <Banner tone="warning" title="Start list was too large to load in full">
                    Some entrants were not loaded, so “not on the start list” may be inaccurate.
                    Check a sample before publishing.
                  </Banner>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handlePublish}
                disabled={!ranked || busy || blocking || session.storedRows === 0}
                isLoading={busy}
              >
                <Send className="size-4" aria-hidden />
                Publish results
              </Button>
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={busy}>
                <XCircle className="size-4" aria-hidden />
                Cancel import
              </Button>
            </div>

            <p className="text-fs-2xs leading-relaxed text-muted-foreground">
              Gender, age-group and category ranks are intentionally not calculated in this
              release — they need an approved data source. Public result pages, participant
              result pages and certificate integration are also not part of this release.
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}

function CheckRow({ ok, label, warn = false }: { ok: boolean; label: string; warn?: boolean }) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : AlertCircle
  return (
    <li className="flex items-start gap-2 text-fs-sm">
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          ok ? 'text-success' : warn ? 'text-warning' : 'text-destructive',
        )}
        aria-hidden
      />
      <span className={ok ? 'text-muted-foreground' : 'text-foreground'}>{label}</span>
    </li>
  )
}

export { Medal as RankIcon }
