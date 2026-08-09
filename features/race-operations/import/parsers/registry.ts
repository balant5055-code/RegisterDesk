// RD-RACEOPS-01 Sprint 2 · Parser provider registry.
//
// THE extension point. Adding RaceTecParser / MyLapsParser / NovaRaceParser means
// appending to RESULT_PARSERS — nothing downstream changes, because every provider
// returns a ParsedTable and the mapping layer turns that into NormalizedRaceResult[].
//
// Order matters only for overlapping extensions: the FIRST provider whose `supports()`
// returns true wins. A future vendor provider that also claims '.csv' must therefore be
// registered BEFORE the generic csvParser and must sniff its own signature in
// `supports()`, so the generic provider remains the fallback.

import { csvParser } from './csv/csvParser'
import { excelParser } from './excel/excelParser'
import {
  extensionOf, type ResultFileSource, type ResultParser,
} from './types'
import {
  RESULTS_ACCEPTED_EXTENSIONS, RESULTS_MAX_FILE_BYTES, formatMaxFileSize,
} from '../constants'

/** Vendor-specific providers go ABOVE the generic ones. */
export const RESULT_PARSERS: readonly ResultParser[] = [
  excelParser,
  csvParser,
]

export type ResolveParserOutcome =
  | { ok: true;  parser: ResultParser }
  | { ok: false; message: string }

/**
 * Gate + provider selection in one place: extension, size, then provider match. Runs
 * before any file content is read, so an unsupported or oversized file never reaches a
 * parser.
 */
export function resolveParser(file: ResultFileSource): ResolveParserOutcome {
  const ext = extensionOf(file.name)

  if (!ext) {
    return { ok: false, message: `This file has no extension. Upload a ${RESULTS_ACCEPTED_EXTENSIONS.join(' or ')} file.` }
  }

  if (!(RESULTS_ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    const future = ext === '.pdf' || ext === '.zip'
      ? ` ${ext.slice(1).toUpperCase()} results are planned for a later release.`
      : ''
    return {
      ok: false,
      message: `${ext} files are not supported. Upload a ${RESULTS_ACCEPTED_EXTENSIONS.join(' or ')} file.${future}`,
    }
  }

  if (file.size === 0) {
    return { ok: false, message: 'This file is empty — there is nothing to import.' }
  }

  if (file.size > RESULTS_MAX_FILE_BYTES) {
    return { ok: false, message: `This file is too large. The maximum size is ${formatMaxFileSize()}.` }
  }

  const parser = RESULT_PARSERS.find(p => p.supports(file))
  if (!parser) {
    return { ok: false, message: `No reader is available for ${ext} files.` }
  }

  return { ok: true, parser }
}
