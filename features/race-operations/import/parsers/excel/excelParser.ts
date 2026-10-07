// RD-RACEOPS-01 Sprint 2 · Excel (.xlsx) provider.
//
// Reads through `lib/xlsx/readWorkbook` — the app's one workbook reader, which wraps
// `read-excel-file/browser` with the OOXML inline-string repair (RD-RESULTS-XLSX-01).
// It is still loaded via dynamic import, so the reader stays out of the initial bundle.
//
// Unlike the registration importer this provider expects NO RegisterDesk template and
// NO metadata sheet: a results file is produced by a third-party timing system, so the
// layout is unknown by definition. That is exactly why the mapping step exists.
//
// Testability: the workbook reader is injected (`readWorkbook`), so the sheet-selection
// and tabulation logic is unit-tested in Node with no browser and no real .xlsx file.

import { tabulate, type RawCell } from '../tabulate'
import { describeWorkbookError, logWorkbookException } from './workbookErrors'
import { extensionOf, type ParseOutcome, type ResultFileSource, type ResultParser } from '../types'

export const EXCEL_PROVIDER_ID = 'excel'

export interface WorkbookSheet {
  sheet: string
  data:  RawCell[][]
}

/** The injectable reader. Mirrors read-excel-file's all-sheets return shape. */
export type WorkbookReader = (file: ResultFileSource) => Promise<WorkbookSheet[]>

const browserWorkbookReader: WorkbookReader = async file => {
  const { readWorkbookSheets } = await import('@/lib/xlsx/readWorkbook')
  // The reader accepts a Blob/File; ResultFileSource is the structural subset we depend
  // on, so the cast is confined to this one boundary line.
  return (await readWorkbookSheets(file as unknown as Blob)) as unknown as WorkbookSheet[]
}

/**
 * Picks the sheet to import: the first sheet that has at least a header row and one
 * data row. A timing export often carries trailing "Notes"/"Summary" sheets, and an
 * empty first sheet should not fail the whole upload.
 */
export function selectResultsSheet(sheets: WorkbookSheet[]): WorkbookSheet | null {
  const hasRows = (s: WorkbookSheet) => Array.isArray(s.data) && s.data.length >= 2
  // RD-RACEOPS-02C · a RegisterDesk template names its data sheet "Results" and carries a
  // "How to fill" sheet beside it. The named sheet wins when it has rows, so the
  // instructions can never be read as results; any other workbook keeps the first sheet
  // with data, as before.
  const named = sheets.find(s => typeof s.sheet === 'string' && s.sheet.trim().toLowerCase() === 'results')
  if (named && hasRows(named)) return named
  return sheets.find(hasRows) ?? null
}

/**
 * RD-RACEOPS-RESULTS-04 · picks the checkpoint sheet, BY NAME ONLY.
 *
 * Deliberately stricter than `selectResultsSheet`: results are what an organizer came to
 * upload, so finding them is worth a fallback, but a sheet is only treated as checkpoints
 * when it actually says "Splits". Guessing would let a "Notes" or "Prizes" tab become
 * everybody's race data. Accepts the plural and singular, and ignores case and spacing.
 *
 * The sheet the results came from is excluded, so a single-sheet workbook can never be read
 * as both.
 */
export function selectSplitsSheet(
  sheets: WorkbookSheet[], resultsSheetName: string | null,
): WorkbookSheet | null {
  const named = sheets.find(s => {
    if (typeof s.sheet !== 'string') return false
    const name = s.sheet.trim().toLowerCase()
    return (name === 'splits' || name === 'split') && s.sheet !== resultsSheetName
  })
  // Header-only is a template nobody filled in: not an error, simply no splits.
  return named && Array.isArray(named.data) && named.data.length >= 2 ? named : null
}

export function createExcelParser(readWorkbook: WorkbookReader = browserWorkbookReader): ResultParser {
  return {
    id:         EXCEL_PROVIDER_ID,
    label:      'Excel workbook',
    extensions: ['.xlsx'],

    supports(file) {
      return this.extensions.includes(extensionOf(file.name))
    },

    async parse(file: ResultFileSource): Promise<ParseOutcome> {
      let sheets: WorkbookSheet[]
      try {
        sheets = await readWorkbook(file)
      } catch (error) {
        logWorkbookException('read-workbook', error)
        return { ok: false, message: describeWorkbookError(error) }
      }

      if (!Array.isArray(sheets) || sheets.length === 0) {
        logWorkbookException('read-workbook', new Error(`reader returned ${Array.isArray(sheets) ? 'no sheets' : typeof sheets}`))
        return { ok: false, message: 'No sheets were found in this workbook. Re-save it as .xlsx or export it as CSV.' }
      }

      const sheet = selectResultsSheet(sheets)
      if (!sheet) {
        return { ok: false, message: 'This workbook has no sheet containing result rows — every sheet is empty or header-only.' }
      }

      const outcome = tabulate(sheet.data, { provider: EXCEL_PROVIDER_ID, sheetName: sheet.sheet })
      if (!outcome.ok) return outcome

      // RD-RACEOPS-RESULTS-04 · the checkpoint sheet, when there is one. A problem reading it
      // never fails the upload: the core results are what the organizer is publishing, and
      // `splitTable: null` simply means no checkpoints were found to attach.
      const splitsSheet = selectSplitsSheet(sheets, sheet.sheet)
      if (!splitsSheet) return outcome
      const splits = tabulate(splitsSheet.data, { provider: EXCEL_PROVIDER_ID, sheetName: splitsSheet.sheet })

      return { ...outcome, splitTable: splits.ok ? splits.table : null }
    },
  }
}

export const excelParser: ResultParser = createExcelParser()
