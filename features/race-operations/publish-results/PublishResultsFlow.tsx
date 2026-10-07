'use client'

// RD-RACEOPS-01 · Race Operations — Publish Results flow.
//
// The full flow, as it actually runs:
//
//   Event → Race → Prepare & upload → Map columns → Validate (file + start-list dry run)
//   → Import (create session → store rows → verify against the start list → rank
//     → build the public snapshot) → Review → Publish
//
// Stages 1–5 are browser-only apart from the start-list DRY RUN, which reads and writes
// nothing: parsing, mapping, validation and the preview run in memory. The first write of
// any kind happens when the organizer presses Import.
//
// RD-RACEOPS-02C · the organizer must never guess the file format. Stage 3 offers the
// race's start list and the results template for download (both derived from the canonical
// result model), states the file's contract from that same model, and still accepts any
// timing-system export. Mapping shows what was detected against what was guessed.
//
// After publishing, the EXISTING certificate module is what issues certificates.
// This flow only links to it (see components below) — it never wraps, replaces, or
// modifies certificate code.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Award, CheckCircle2, Database, FileSpreadsheet } from 'lucide-react'
import { Banner, Button, Card, buttonVariants } from '@/components/ui'
import { ColumnMappingPanel } from '@/features/race-operations/components/ColumnMappingPanel'
import { configurePdfParser } from '@/features/race-operations/import/parsers/pdf/pdfParser'
import { useAuth } from '@/components/auth/AuthProvider'
import { EventSelector } from '@/features/race-operations/components/EventSelector'
import { ImportSessionHistory } from '@/features/race-operations/components/ImportSessionHistory'
import { PrepareUploadPanel } from '@/features/race-operations/components/PrepareUploadPanel'
import { RaceSelector } from '@/features/race-operations/components/RaceSelector'
import { ResultsFileDropzone } from '@/features/race-operations/components/ResultsFileDropzone'
import { ResultsPreviewTable } from '@/features/race-operations/components/ResultsPreviewTable'
import { SessionReviewPanel } from '@/features/race-operations/components/SessionReviewPanel'
import { PublishedRacePanel } from '@/features/race-operations/components/PublishedRacePanel'
import { StageSection } from '@/features/race-operations/components/StageSection'
import { StageStepper } from '@/features/race-operations/components/StageStepper'
import { ValidationSummaryPanel } from '@/features/race-operations/components/ValidationSummaryPanel'
import { useRaceOpsEvents, type RaceOpsEventRow } from '@/features/race-operations/hooks/useRaceOpsEvents'
import { useResultImportSession } from '@/features/race-operations/hooks/useResultImportSession'
import { useSessionCommit } from '@/features/race-operations/hooks/useSessionCommit'
import { useStartListCheck } from '@/features/race-operations/hooks/useStartListCheck'
import type { RaceOpsRaceSelection, RaceOpsStageKey } from '@/features/race-operations/types'
import { EVENT_SUBTYPE_NAMES } from '@/lib/events/taxonomy'
import { ROUTES } from '@/config/navigation'

/** "10K · Running results" — the sport comes from the event's own subtype, never assumed. */
function raceTitle(event: RaceOpsEventRow, race: RaceOpsRaceSelection): string {
  const sport = event.eventSubtype ? EVENT_SUBTYPE_NAMES.sports?.[event.eventSubtype] : null
  return sport && sport !== 'Other' ? `${race.name} · ${sport} results` : `${race.name} results`
}

export function PublishResultsFlow() {
  const eventsState = useRaceOpsEvents()
  const session     = useResultImportSession()
  const commit      = useSessionCommit()

  const [event, setEvent] = useState<RaceOpsEventRow | null>(null)
  const [race,  setRace]  = useState<RaceOpsRaceSelection | null>(null)

  // RD-RACEOPS-RESULTS-06 · a PDF is parsed on the SERVER, and the route authorizes that
  // parse against the organizer's own event. The parser is told which event is in play the
  // moment one is chosen; without it the route refuses, so a mis-sequenced UI fails closed.
  //
  // RD-RACEOPS-RESULTS-07A · …and which token source to sign the request with — the SAME
  // `getToken` every other race-ops call in this flow uses. Without it the parser refused
  // nothing and the server refused everything (07's P1: every PDF upload was a 401).
  const { getToken } = useAuth()
  useEffect(() => { configurePdfParser({ eventId: event?.eventId ?? null, getToken }) }, [event, getToken])

  const handleSelectEvent = useCallback((next: RaceOpsEventRow) => {
    setEvent(next)
    setRace(null)              // a new event invalidates the race choice
    session.reset()            // …and the uploaded file, which belonged to the old race
    commit.reset()             // …and any commit in progress for it
  }, [session, commit])

  const handleSelectRace = useCallback((next: RaceOpsRaceSelection) => {
    setRace(next)
    session.reset()            // a file is only meaningful for the race it was uploaded for
    commit.reset()
  }, [session, commit])

  // Only rows the CLIENT considers usable are sent; the server re-validates them anyway.
  const usableRows = useMemo(
    () => (session.validation?.rows ?? []).filter(r => r.usable).map(r => r.result),
    [session.validation],
  )
  const usableRowCount = usableRows.length

  // RD-RACEOPS-02C · the start-list dry run — the server's own answer, before Import.
  const startList = useStartListCheck({
    eventId: event?.eventId ?? null,
    passId:  race?.passId ?? null,
    rows:    useMemo(() => usableRows.map(r => ({ rowNumber: r.rowNumber, bib: r.bibNumber ?? '' })), [usableRows]),
  })
  const startListBlocking = startList.phase === 'done' && startList.result.blocking

  const handleImport = useCallback(async () => {
    if (!event || !race || !session.table || usableRows.length === 0) return
    await commit.start({
      eventId:   event.eventId,
      passId:    race.passId,
      fileName:  session.fileName ?? 'results',
      fileHash:  session.fileHash,
      provider:  session.table.provider,
      mapping:   session.mapping,
      results:   usableRows,
      totalRows: session.validation?.summary.rowsFound ?? usableRows.length,
    })
  }, [event, race, session, usableRows, commit])

  // The furthest stage reached, from the commit phase downwards.
  const currentStage: RaceOpsStageKey =
    commit.phase === 'published'    ? 'publish'
    : commit.phase === 'publishing' ? 'publish'
    : commit.phase === 'review'     ? 'review'
    : commit.phase === 'ranking' || commit.phase === 'snapshotting' ? 'rank'
    : commit.phase === 'verifying' || commit.phase === 'creating' || commit.phase === 'storing' ? 'verify'
    : session.validation           ? 'validate'
    : session.table                ? 'map'
    : race                         ? 'upload'
    : event                        ? 'race'
    : 'event'

  return (
    <div className="space-y-5">
      <StageStepper current={currentStage} />

      <Banner tone="info" title="Publishing makes these results public">
        Nothing is saved until you press Import. Imported results are checked against your
        start list, ranked, and prepared for the public results page — then published only
        when you confirm. Once published they appear on the public results and participant
        pages, and they supply the finish time and position on certificates and finisher badges.
      </Banner>

      {/* ── Stage 1 · Event ──────────────────────────────────────────────── */}
      <StageSection
        title="1 · Select event"
        description="Sports events in your workspace. Results can be recorded for live, closed and completed events."
      >
        <EventSelector
          state={eventsState}
          selectedEventId={event?.eventId ?? null}
          onSelect={handleSelectEvent}
        />
      </StageSection>

      {/* ── Stage 2 · Race (distance) ────────────────────────────────────── */}
      {event && (
        <StageSection
          title="2 · Select race"
          description="Each race is a pass on the event, so this list mirrors the passes you already configured. One results file covers one race."
        >
          <RaceSelector
            races={event.races}
            selectedPassId={race?.passId ?? null}
            onSelect={handleSelectRace}
          />
        </StageSection>
      )}

      {/* ── Stage 3 · Prepare & upload ───────────────────────────────────── */}
      {event && race && (
        <StageSection
          title="3 · Prepare & upload"
          description={`${event.name} — ${raceTitle(event, race)}. Download the start list or the template, or upload your timing system's export as it comes.`}
        >
          <PrepareUploadPanel eventId={event.eventId} passId={race.passId} raceName={race.name}>
            <ResultsFileDropzone
              onFileSelected={file => { void session.selectFile(file) }}
              busy={session.phase === 'parsing'}
              fileName={session.fileName}
              fileSize={session.fileSize}
              error={session.error}
              onClear={session.reset}
            />
          </PrepareUploadPanel>
          <ImportSessionHistory entries={session.history} />
        </StageSection>
      )}

      {/* ── Stage 4 · Column mapping ─────────────────────────────────────── */}
      {race && session.table && (
        <StageSection
          title="4 · Map columns"
          description={
            session.table.sheetName
              ? `Read ${session.table.rows.length.toLocaleString('en-IN')} rows from sheet "${session.table.sheetName}". Each RegisterDesk field shows the file column that feeds it — change any of them before validating.`
              : `Read ${session.table.rows.length.toLocaleString('en-IN')} rows. Each RegisterDesk field shows the file column that feeds it — change any of them before validating.`
          }
        >
          <ColumnMappingPanel
            headers={session.table.headers}
            mapping={session.mapping}
            source={session.mappingSource}
            missingRequired={session.missingRequired}
            onChange={session.setColumn}
          />
        </StageSection>
      )}

      {/* ── Stage 5 · Validation + start-list dry run ───────────────────── */}
      {race && session.validation && (
        <StageSection
          title="5 · Validate"
          description="The file is checked against itself in your browser, and its bibs are checked against this race's start list on the server. Nothing is saved."
        >
          <ValidationSummaryPanel
            validation={session.validation}
            raceName={race.name}
            startList={startList}
            // RD-RACEOPS-RESULTS-04 · checkpoints are read from a second sheet the organizer
            // may not realise was picked up (or, worse, may believe was). Say which.
            splits={session.splitTable ? { participants: session.splitParticipants, rows: session.splitTable.rows.length } : null}
          />
        </StageSection>
      )}

      {/* ── Preview ──────────────────────────────────────────────────────── */}
      {race && session.validation?.canPreview && (
        <StageSection
          title="Preview"
          description="What your file contains after mapping and validation. Nothing has been saved yet — importing is the next step."
        >
          <ResultsPreviewTable rows={session.validation.rows} />
        </StageSection>
      )}

      {/* ── Stages 6–9 · Import: verify, rank, review, publish ───────────── */}
      {race && event && session.validation?.canPreview && (
        <StageSection
          title="6–9 · Verify, rank, review and publish"
          description="Stores the validated rows as a draft, checks every bib against your start list, ranks the finishers and prepares the public page — then lets you review everything before publishing."
        >
          {commit.phase === 'idle' ? (
            <Card>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-fs-md font-semibold text-foreground">
                    Ready to import
                  </h3>
                  <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
                    {usableRowCount.toLocaleString('en-IN')} of{' '}
                    {session.validation.summary.rowsFound.toLocaleString('en-IN')} rows will be
                    stored as a draft. Nothing is published until you review and confirm.
                    {startListBlocking && ' Fix the start-list problems shown above first — the import would be refused at verification.'}
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  disabled={usableRowCount === 0 || startListBlocking || startList.phase === 'checking'}
                  onClick={() => void handleImport()}
                >
                  <Database className="size-4" aria-hidden />
                  Import {usableRowCount.toLocaleString('en-IN')} results
                </Button>
              </div>
            </Card>
          ) : commit.session ? (
            <SessionReviewPanel
              phase={commit.phase}
              session={commit.session}
              progress={commit.progress}
              error={commit.error}
              verification={commit.verification}
              onPublish={() => void commit.publish()}
              onCancel={reason => void commit.cancel(reason)}
            />
          ) : (
            <Banner tone="error" title="The import could not start">
              {commit.error ?? 'Please try again.'}
            </Banner>
          )}
        </StageSection>
      )}

      {/* ── RD-RESULTS-FINAL-01 · the published race ─────────────────────── */}
      {/* Version history, rollback and export. Rendered whenever a race is selected —
          it is about the PUBLISHED race, not the import in progress, so it stays visible
          after a publish and on a return visit with no import underway. */}
      {event && race && (
        <StageSection
          title="Published results"
          description="Every published version of this race. Restore an earlier one or export the live one."
        >
          <PublishedRacePanel
            eventId={event.eventId}
            passId={race.passId}
            raceName={race.name}
            reloadKey={commit.phase === 'published' ? 1 : 0}
          />
        </StageSection>
      )}

      {/* ── Certificates — existing module, LINK ONLY ────────────────────── */}
      {race && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3.5">
              <div
                className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted"
                aria-hidden
              >
                <Award className="size-[18px] text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold text-foreground">Certificates</h3>
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    <CheckCircle2 className="size-3" aria-hidden />
                    Available now
                  </span>
                </div>
                <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
                  Certificates are issued by the existing certificate module and take the
                  finish time and position from the published results. Race Operations links
                  to it — it does not replace it.
                </p>
              </div>
            </div>
            <Link
              href={ROUTES.DASHBOARD_CERTIFICATES}
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'shrink-0' })}
            >
              <FileSpreadsheet className="size-4" aria-hidden />
              Open Certificates
            </Link>
          </div>
        </Card>
      )}
    </div>
  )
}
