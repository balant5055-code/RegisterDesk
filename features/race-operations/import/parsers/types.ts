// RD-RACEOPS-01 Sprint 2 · Parser provider contract.
//
// SDK-free and DOM-free: `ResultFileSource` is the minimal shape a provider needs, so
// providers and their pure cores are unit-testable in Node without a File object.
//
// ─── Extensibility contract ──────────────────────────────────────────────────
// A new provider (RaceTecParser, MyLapsParser, NovaRaceParser, …) is added by:
//   1. implementing `ResultParser`,
//   2. registering it in ./registry.ts.
// NOTHING downstream changes. Validation, summary, report and preview consume only
// `NormalizedRaceResult`, and a provider that knows its own vendor layout declares a
// `presetMapping` so the organizer is not asked to map columns by hand.

import type { ColumnMapping, ParsedTable } from '@/features/race-operations/types/results'

/** The provider-visible view of an uploaded file. A browser `File` satisfies this
 *  structurally, so callers pass a File directly and tests pass a literal. */
export interface ResultFileSource {
  name: string
  size: number
  /** Present for real uploads; a provider's pure core never needs it. */
  arrayBuffer?: () => Promise<ArrayBuffer>
  text?:        () => Promise<string>
}

export type ParseOutcome =
  | { ok: true;  table: ParsedTable }
  /** `message` is organizer-facing and must never contain a stack trace. */
  | { ok: false; message: string }

export interface ResultParser {
  /** Stable identifier, stored on every record as `sourceProvider`. */
  id:         string
  label:      string
  /** Lower-case extensions this provider claims, e.g. ['.csv']. */
  extensions: readonly string[]
  /**
   * A vendor provider whose column layout is known declares it here, so the mapping
   * step is pre-filled instead of guessed. Generic CSV/Excel providers omit it and
   * fall back to alias auto-detection plus manual override.
   */
  presetMapping?: ColumnMapping
  supports(file: ResultFileSource): boolean
  parse(file: ResultFileSource): Promise<ParseOutcome>
}

/** Lower-cased extension including the dot, or '' when the name has none. */
export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i === -1 ? '' : fileName.slice(i).toLowerCase()
}
