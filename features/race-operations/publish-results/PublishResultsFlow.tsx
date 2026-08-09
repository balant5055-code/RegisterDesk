'use client'

// RD-RACEOPS-01 · Race Operations — Publish Results flow.
//
// The full flow, as it actually runs:
//
//   Event → Race → Upload → Parse → Map columns → Validate → Preview
//   → Import (create session → store rows → verify against the start list → rank
//     → build the public snapshot) → Review → Publish
//
// Stages 1–7 are browser-only: parsing, mapping, validation and the preview table all
// run in memory and write nothing. The first write of any kind happens when the organizer
// presses Import in stage 8.
//
// RD-RESULTS-CLOSURE-02 · this header, the banner and the stage descriptions previously
// described Sprint 1/2 scope and stated that publishing was not built and that results
// never reached a public page. Both had been false since Sprint 3.
//
// After publishing, the EXISTING certificate module is what issues certificates.
// This flow only links to it (see components below) — it never wraps, replaces, or
// modifies certificate code.

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Award, CheckCircle2, Database, FileSpreadsheet, ListChecks,
} from 'lucide-react'
import { Banner, Button, Card, buttonVariants } from '@/components/ui'
import { ColumnMappingPanel } from '@/features/race-operations/components/ColumnMappingPanel'
import { EventSelector } from '@/features/race-operations/components/EventSelector'
import { ImportSessionHistory } from '@/features/race-operations/components/ImportSessionHistory'
import { PlannedStage } from '@/features/race-operations/components/PlannedStage'
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
import type { RaceOpsRaceSelection, RaceOpsStageKey } from '@/features/race-operations/types'
import { ROUTES } from '@/config/navigation'

export function PublishResultsFlow() {
  const eventsState = useRaceOpsEvents()
  const session     = useResultImportSession()
  const commit      = useSessionCommit()

  const [event, setEvent] = useState<RaceOpsEventRow | null>(null)
  const [race,  setRace]  = useState<RaceOpsRaceSelection | null>(null)

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

  // The furthest stage reached. Sprint 3 completes the flow, so 'publish' is now genuinely
  // reachable — it lights up only once results are actually published.
  const currentStage: RaceOpsStageKey =
    commit.phase === 'published'   ? 'publish'
    : session.validation?.canPreview ? 'preview'
    : session.validation           ? 'validate'
    : session.table                ? 'upload'
    : race                         ? 'upload'
    : event                        ? 'race'
    : 'event'

  return (
    <div className="space-y-5">
      <StageStepper current={currentStage} />

      <Banner tone="info" title="Publishing makes these results public">
        Nothing is saved until you press Import. Imported results are checked against your
        start list, ranked, and prepared for the public results page — then published only
        when you confirm. Once published they appear on the public results and runner pages,
        and they supply the finish time and position on certificates and finisher badges.
      </Banner>

      {/* ── Stage 1 · Event ──────────────────────────────────────────────── */}
      <StageSection
        title="1 · Select event"
        description="Only events in your workspace are listed. Results can be recorded for live, closed and completed events."
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
          description="Each race distance is a pass on the event, so this list mirrors the passes you already configured."
        >
          <RaceSelector
            races={event.races}
            selectedPassId={race?.passId ?? null}
            onSelect={handleSelectRace}
          />
        </StageSection>
      )}

      {/* ── Stages 3–6 · declared placeholders ───────────────────────────── */}
      {/* ── Stage 3 · Upload (Sprint 2 — live) ───────────────────────────── */}
      {race && (
        <StageSection
          title="3 · Upload results"
          description={`${event?.name ?? ''} — ${race.name}. Export the file from your timing system as it comes; you will map its columns next.`}
        >
          <ResultsFileDropzone
            onFileSelected={file => { void session.selectFile(file) }}
            busy={session.phase === 'parsing'}
            fileName={session.fileName}
            fileSize={session.fileSize}
            error={session.error}
            onClear={session.reset}
          />
          <ImportSessionHistory entries={session.history} />
        </StageSection>
      )}

      {/* ── Stage 4a · Column mapping (Sprint 2 — live) ───────────────────── */}
      {race && session.table && (
        <StageSection
          title="4 · Map columns"
          description={
            session.table.sheetName
              ? `Read ${session.table.rows.length.toLocaleString('en-IN')} rows from sheet "${session.table.sheetName}". Confirm which column holds each value.`
              : `Read ${session.table.rows.length.toLocaleString('en-IN')} rows. Confirm which column holds each value.`
          }
        >
          <ColumnMappingPanel
            headers={session.table.headers}
            mapping={session.mapping}
            missingRequired={session.missingRequired}
            onChange={session.setColumn}
          />
        </StageSection>
      )}

      {/* ── Stage 4b · Validation (Sprint 2 — live) ───────────────────────── */}
      {race && session.validation && (
        <StageSection
          title="5 · Validation"
          description="Every check below runs against the uploaded file only, and nothing is saved. Your bibs are checked against the start list during Import, in the next step."
        >
          <ValidationSummaryPanel validation={session.validation} raceName={race.name} />
        </StageSection>
      )}

      {/* ── Stage 5 · Preview — SPRINT 2 ENDS HERE ────────────────────────── */}
      {race && session.validation?.canPreview && (
        <StageSection
          title="6 · Preview"
          description="This is what your file contains after mapping and validation. Nothing has been saved yet — importing is the next step."
        >
          <ResultsPreviewTable rows={session.validation.rows} />
        </StageSection>
      )}

      {/* ── Stage 7 · Import, verify, rank, snapshot, review, publish ─────── */}
      {race && event && session.validation?.canPreview && (
        <StageSection
          title="7 · Import, verify, rank and publish"
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
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  disabled={usableRowCount === 0}
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

      {/* ── Beyond Sprint 3 ──────────────────────────────────────────────── */}
      {race && (
        <StageSection
          title="Not in this release"
          description="Published results are live, searchable and feed certificates and badges. These rank scopes are still to come."
        >
          <div className="space-y-2.5">
            <PlannedStage
              icon={ListChecks}
              title="Gender, age-group and category ranking"
              sprint="A later sprint"
              description="Additional rank scopes, once the data source is agreed."
              capabilities={[
                'Gender and age-group placings',
                'Category placings',
                'Requires an approved source — these fields are stored but not yet ranked',
              ]}
            />
            </div>

          {/* Existing certificate module — LINK ONLY. No certificate code is
              touched, wrapped, or duplicated by Race Operations. */}
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
                    Certificates are issued by the existing certificate module and already
                    work independently of results. Race Operations links to it — it does not
                    replace it.
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
        </StageSection>
      )}
    </div>
  )
}
