// RD-RACEOPS-01 Sprint 2 · Human explanations for workbook-reader failures.
//
// Same doctrine as the registration importer: the REAL exception is always logged;
// the organizer only ever sees a specific, actionable sentence — never a stack trace.
//
// Why this is module-local rather than imported: the equivalent helpers
// (`describeWorkbookError`, `logParserException`) live INSIDE
// app/(dashboard)/dashboard/events/[eventId]/registrations/ImportParticipantsDrawer.tsx
// and are not exported. Importing them would mean editing that production file purely
// to widen its surface, which this sprint's rules forbid. The messages here are also
// materially different: a results file comes from a third-party timing provider, so
// "re-download the template" — the right advice there — would be wrong here.

export function logWorkbookException(stage: string, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error))
  if (process.env.NODE_ENV === 'production') {
    console.error(`[raceops-parser:${stage}] ${e.name}: ${e.message}`)
  } else {
    console.error(`[raceops-parser:${stage}]`, { type: e.name, message: e.message, stack: e.stack })
  }
}

/** Turns a workbook-reader exception into a specific, human explanation. */
export function describeWorkbookError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()

  if (/zip|central directory|eocd|signature|compress|inflate|end of central|deflate/.test(msg)) {
    return 'This workbook appears to be corrupted — its internal structure could not be read. Ask your timing provider to re-export it, or save it again as .xlsx.'
  }
  if (/xml|parse|token|tag|entity|malformed|dom|unexpected/.test(msg)) {
    return 'This workbook contains invalid XML and could not be read. Open it in Excel, re-save as .xlsx, and upload again.'
  }
  if (/password|encrypt|protected/.test(msg)) {
    return 'This workbook is password-protected. Remove the protection and upload it again.'
  }
  if (/not a|invalid file|unsupported|format|magic|zip file/.test(msg)) {
    return 'This is not a valid .xlsx workbook. Upload a .xlsx or .csv file — not .xls, and not a renamed file.'
  }
  return 'This workbook could not be read. Re-save it as .xlsx or export it as CSV and try again.'
}
