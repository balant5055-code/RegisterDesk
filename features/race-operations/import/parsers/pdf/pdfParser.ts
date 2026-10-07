// RD-RACEOPS-RESULTS-06 · PDF provider.
//
// Implements the EXISTING `ResultParser` contract, so the registry, the mapping step, the
// validation engine and the whole commit path treat a PDF exactly as they treat a workbook.
// Nothing downstream knows a PDF was involved.
//
// ─── The one difference from CSV and XLSX ───────────────────────────────────
// Those providers parse in the browser. This one POSTs the bytes to
// `/api/organizer/race-operations/results/parse-pdf` and tabulates what comes back: the PDF
// reader is a large parser over untrusted input, and it belongs on the server behind the
// authorization this module already has. The organizer's bundle gains nothing but this file.
//
// The route needs the event to authorize the parse, and `ResultFileSource` deliberately
// carries no event — so the flow sets it through `configurePdfParser` when the organizer
// picks a race, exactly as it already sets the race before a file may be chosen.
//
// RD-RACEOPS-RESULTS-07A · the flow also supplies the TOKEN SOURCE. This module is not a
// React hook and cannot call `useAuth()`, and the route — correctly — refuses a request with
// no `Authorization: Bearer <Firebase ID token>` (07's P1: every upload returned 401). The
// same `getToken` that `useSessionCommit` uses for every other race-ops call is injected
// here, so there is ONE authentication mechanism and this parser is simply another caller
// of it. No token source, or no token, means no request: never an anonymous attempt.

import { tabulate } from '../tabulate'
import { extensionOf, type ParseOutcome, type ResultFileSource, type ResultParser } from '../types'
import type { ParsePdfResponse } from '@/app/api/organizer/race-operations/results/parse-pdf/route'

export const PDF_PROVIDER_ID = 'pdf'

const ENDPOINT = '/api/organizer/race-operations/results/parse-pdf'

/** The Firebase ID-token source the flow already holds (`useAuth().getToken`). */
export type TokenSource = () => Promise<string | null>

export interface PdfParserConfig {
  /**
   * The event whose race is being imported. Set by the flow before a file is accepted; the
   * route refuses the parse without it, so a mis-sequenced UI fails closed rather than
   * parsing somebody else's document.
   */
  eventId:  string | null
  /** Null until the flow mounts; a parse attempted before then fails closed. */
  getToken: TokenSource | null
}

let config: PdfParserConfig = { eventId: null, getToken: null }

export function configurePdfParser(next: PdfParserConfig): void {
  config = next
}

/** The one organizer-facing sentence for "you are not signed in" — the same one `useSessionCommit` uses. */
export const PDF_SESSION_EXPIRED = 'Your session has expired. Please sign in again.'

/**
 * The default transport: the SAME shape as `useSessionCommit`'s `call` — Bearer token,
 * no-store — with the body and content type a PDF upload needs.
 *
 * Throws `PDF_SESSION_EXPIRED` rather than sending when no token can be obtained. An
 * unauthenticated request would only be refused by the server anyway; refusing here means
 * the organizer reads a sentence about their session instead of a generic upload failure.
 */
export async function authenticatedPost(url: string, body: ArrayBuffer): Promise<Response> {
  const token = config.getToken ? await config.getToken() : null
  if (!token) throw new Error(PDF_SESSION_EXPIRED)
  return fetch(url, {
    method:  'POST',
    body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    cache:   'no-store',
  })
}

export function createPdfParser(
  post: (url: string, body: ArrayBuffer) => Promise<Response> = authenticatedPost,
): ResultParser {
  return {
    id:         PDF_PROVIDER_ID,
    label:      'PDF results',
    extensions: ['.pdf'],

    supports(file) {
      return this.extensions.includes(extensionOf(file.name))
    },

    async parse(file: ResultFileSource): Promise<ParseOutcome> {
      if (!file.arrayBuffer) {
        return { ok: false, message: 'This file could not be read. Try selecting it again.' }
      }
      const eventId = config.eventId
      if (!eventId) {
        return { ok: false, message: 'Choose the event and race before uploading a PDF.' }
      }

      let bytes: ArrayBuffer
      try {
        bytes = await file.arrayBuffer()
      } catch {
        return { ok: false, message: 'This file could not be read. It may have been moved — try selecting it again.' }
      }

      let res: Response
      try {
        res = await post(`${ENDPOINT}?eventId=${encodeURIComponent(eventId)}`, bytes)
      } catch (err) {
        // A missing session is the organizer's problem to fix, and is said so; anything
        // else is the network's.
        if (err instanceof Error && err.message === PDF_SESSION_EXPIRED) return { ok: false, message: PDF_SESSION_EXPIRED }
        return { ok: false, message: 'The PDF could not be sent for reading. Check your connection and try again.' }
      }

      if (!res.ok) {
        // The route's message is already organizer-facing and carries the typed code.
        const body = await res.json().catch(() => null) as { error?: string } | null
        return { ok: false, message: body?.error ?? 'This PDF could not be read as results.' }
      }

      const body = await res.json().catch(() => null) as ParsePdfResponse | null
      if (!body || !Array.isArray(body.results) || body.results.length < 2) {
        return { ok: false, message: 'No result rows were found in this PDF.' }
      }

      // From here on it is an ordinary cell matrix: the SAME `tabulate` the CSV and Excel
      // providers use, so header handling and row numbering cannot drift between formats.
      const table = tabulate(body.results, { provider: PDF_PROVIDER_ID, sheetName: `PDF (${body.shape})` })
      if (!table.ok) return table

      if (!Array.isArray(body.splits) || body.splits.length < 2) return table

      const splits = tabulate(body.splits, { provider: PDF_PROVIDER_ID, sheetName: 'PDF splits' })
      return { ...table, splitTable: splits.ok ? splits.table : null }
    },
  }
}

export const pdfParser: ResultParser = createPdfParser()
