'use client'

// RD-RACEOPS-01 Sprint 2 · Result import session.
//
// Owns the client-side pipeline state: file → parse → map → validate → preview.
//
// Everything is IN MEMORY for the browser session only. There is no Firestore write, no
// API call, and no persistence of any kind — including the import history, which the
// sprint brief explicitly scopes to "session only". Reloading the page clears it, by
// design.
//
// Parsing runs in the browser (read-excel-file/browser), and validation is self-contained
// by contract, so Sprint 2 needs no API route at all.

import { useCallback, useMemo, useState } from 'react'
import {
  applyMapping, autoMapColumns, missingRequiredFields, resolveParser,
  validateResults, RESULTS_MAX_ROWS,
  type ValidationResult,
} from '@/features/race-operations/import'
import type {
  ColumnMapping, NormalizedRaceResult, ParsedTable, ResultField,
} from '@/features/race-operations/types/results'
import { hashFile } from '@/features/race-operations/utils/fileHash'

export type ImportPhase = 'idle' | 'parsing' | 'mapping' | 'validating' | 'ready' | 'failed'

/** One completed (or failed) upload in this browser session. */
export interface ImportSessionEntry {
  id:          string
  fileName:    string
  fileSize:    number
  provider:    string | null
  /** ISO string captured at the moment the upload settled. */
  at:          string
  outcome:     'parsed' | 'failed'
  rowsFound:   number
  validRows:   number
  errorCount:  number
  warningCount: number
  message:     string | null
}

export interface ResultImportSession {
  phase:            ImportPhase
  fileName:         string | null
  fileSize:         number
  /** SHA-256 of the uploaded bytes; '' when Web Crypto is unavailable. Sprint 3 records
   *  it on the Import Session as provenance. */
  fileHash:         string
  table:            ParsedTable | null
  mapping:          ColumnMapping
  unmappedHeaders:  string[]
  missingRequired:  ResultField[]
  normalized:       NormalizedRaceResult[]
  validation:       ValidationResult | null
  error:            string | null
  history:          ImportSessionEntry[]

  selectFile:  (file: File) => Promise<void>
  setColumn:   (field: ResultField, header: string | null) => void
  reset:       () => void
}

/** Session-scoped id. Not crypto — it only keys a React list. */
let sessionCounter = 0
const nextSessionId = () => `rio-${++sessionCounter}`

export function useResultImportSession(): ResultImportSession {
  const [phase,     setPhase]     = useState<ImportPhase>('idle')
  const [fileName,  setFileName]  = useState<string | null>(null)
  const [fileSize,  setFileSize]  = useState(0)
  const [fileHash,  setFileHash]  = useState('')
  const [table,     setTable]     = useState<ParsedTable | null>(null)
  const [mapping,   setMapping]   = useState<ColumnMapping>({})
  const [unmapped,  setUnmapped]  = useState<string[]>([])
  const [error,     setError]     = useState<string | null>(null)
  const [history,   setHistory]   = useState<ImportSessionEntry[]>([])

  const reset = useCallback(() => {
    setPhase('idle'); setFileName(null); setFileSize(0); setFileHash('')
    setTable(null); setMapping({}); setUnmapped([]); setError(null)
  }, [])

  const selectFile = useCallback(async (file: File) => {
    setPhase('parsing')
    setFileName(file.name)
    setFileSize(file.size)
    setFileHash('')
    setTable(null); setMapping({}); setUnmapped([]); setError(null)

    const record = (
      outcome: ImportSessionEntry['outcome'],
      provider: string | null,
      message: string | null,
      counts: { rowsFound: number; validRows: number; errorCount: number; warningCount: number },
    ) => {
      setHistory(prev => [{
        id: nextSessionId(),
        fileName: file.name,
        fileSize: file.size,
        provider,
        // Captured at the moment of settling — the only place a timestamp is created,
        // and it never leaves the browser.
        at: new Date().toISOString(),
        outcome,
        message,
        ...counts,
      }, ...prev])
    }
    const zero = { rowsFound: 0, validRows: 0, errorCount: 0, warningCount: 0 }

    // Fingerprint the bytes for provenance (Sprint 3 records it on the Import Session).
    // Non-fatal by design: hashFile returns '' rather than throwing, so an unhashable file
    // never blocks an otherwise valid import.
    setFileHash(await hashFile(file))

    const resolved = resolveParser(file)
    if (!resolved.ok) {
      setError(resolved.message); setPhase('failed')
      record('failed', null, resolved.message, zero)
      return
    }

    const outcome = await resolved.parser.parse(file)
    if (!outcome.ok) {
      setError(outcome.message); setPhase('failed')
      record('failed', resolved.parser.id, outcome.message, zero)
      return
    }

    if (outcome.table.rows.length > RESULTS_MAX_ROWS) {
      const message = `This file has ${outcome.table.rows.length.toLocaleString('en-IN')} rows. `
        + `The maximum is ${RESULTS_MAX_ROWS.toLocaleString('en-IN')} per upload — split it by race and upload each separately.`
      setError(message); setPhase('failed')
      record('failed', resolved.parser.id, message, zero)
      return
    }

    // A vendor provider that knows its own layout pre-fills the mapping; generic
    // CSV/Excel fall back to alias auto-detection. Either way the organizer can override.
    const auto = autoMapColumns(outcome.table.headers)
    const initialMapping: ColumnMapping = { ...auto.mapping, ...(resolved.parser.presetMapping ?? {}) }

    setTable(outcome.table)
    setMapping(initialMapping)
    setUnmapped(auto.unmappedHeaders)
    setPhase('mapping')

    // History is recorded against the parse outcome; validation counts are derived
    // reactively below, so the entry reflects the file as uploaded.
    const preview = validateResults(applyMapping(outcome.table, initialMapping), {
      unmappedHeaders: auto.unmappedHeaders,
    })
    record('parsed', resolved.parser.id, null, {
      rowsFound:    preview.summary.rowsFound,
      validRows:    preview.summary.validRows,
      errorCount:   preview.summary.errorCount,
      warningCount: preview.summary.warningCount,
    })
  }, [])

  const setColumn = useCallback((field: ResultField, header: string | null) => {
    setMapping(prev => {
      const next = { ...prev }
      if (header === null) delete next[field]
      else                 next[field] = header
      return next
    })
  }, [])

  // ── Derived: mapping → normalized → validation ──────────────────────────────
  // Recomputed synchronously from state rather than stored, so a mapping change can
  // never leave a stale validation result on screen.
  const normalized = useMemo(
    () => (table ? applyMapping(table, mapping) : []),
    [table, mapping],
  )

  const missingRequired = useMemo(() => missingRequiredFields(mapping), [mapping])

  const validation = useMemo(() => {
    if (!table || missingRequired.length > 0) return null
    // Headers the organizer has since mapped are no longer "unused".
    const used = new Set(Object.values(mapping).filter(Boolean) as string[])
    return validateResults(normalized, {
      unmappedHeaders: unmapped.filter(h => !used.has(h)),
      mapping,
    })
  }, [table, mapping, normalized, unmapped, missingRequired])

  const effectivePhase: ImportPhase = useMemo(() => {
    if (phase !== 'mapping') return phase
    return validation ? 'ready' : 'mapping'
  }, [phase, validation])

  return {
    phase: effectivePhase,
    fileName, fileSize, fileHash, table, mapping,
    unmappedHeaders: unmapped,
    missingRequired,
    normalized,
    validation,
    error,
    history,
    selectFile, setColumn, reset,
  }
}
