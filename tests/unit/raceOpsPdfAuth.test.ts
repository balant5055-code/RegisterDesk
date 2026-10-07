// RD-RACEOPS-RESULTS-07A · The PDF parser authenticates like every other race-ops call.
//
// RESULTS-07's browser audit found every PDF upload returning 401: the parser posted the
// bytes with no `Authorization` header, while the route — correctly — requires the same
// Bearer token every other race-ops client call sends. These tests pin the request the
// parser now makes, and that a missing session fails CLOSED rather than falling back to an
// anonymous attempt. The server side is asserted too: a request with no token is a 401
// before a single byte is parsed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  authenticatedPost, configurePdfParser, createPdfParser, PDF_SESSION_EXPIRED,
} from '@/features/race-operations/import/parsers/pdf/pdfParser'

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 synthetic').buffer as ArrayBuffer
const file = { name: 'results.pdf', size: PDF_BYTES.byteLength, arrayBuffer: async () => PDF_BYTES }

const okBody = { shape: 'table', results: [['Bib', 'Net Time'], ['10571', '00:32:35']], splits: null, pagesUsed: 1, labelMap: {} }

describe('RD-RACEOPS-RESULTS-07A · authenticated PDF request', () => {
  const realFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | null = null

  beforeEach(() => {
    captured = null
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return new Response(JSON.stringify(okBody), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    configurePdfParser({ eventId: null, getToken: null })
  })

  it('1 · sends Authorization: Bearer <token> from the flow\'s token source', async () => {
    configurePdfParser({ eventId: 'evt_1', getToken: async () => 'id-token-abc' })
    const out = await createPdfParser().parse(file)
    expect(out.ok).toBe(true)
    expect(captured).not.toBeNull()
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer id-token-abc')
  })

  it('2 · still sends Content-Type: application/pdf, and never caches', async () => {
    configurePdfParser({ eventId: 'evt_1', getToken: async () => 'id-token-abc' })
    await createPdfParser().parse(file)
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/pdf')
    expect(captured!.init.cache).toBe('no-store')
    expect(captured!.init.method).toBe('POST')
  })

  it('3 · the body is the file\'s own bytes, unchanged, to the existing route', async () => {
    configurePdfParser({ eventId: 'evt 1', getToken: async () => 't' })
    await createPdfParser().parse(file)
    expect(captured!.init.body).toBe(PDF_BYTES)
    expect(captured!.url).toBe('/api/organizer/race-operations/results/parse-pdf?eventId=evt%201')
  })

  it('4 · an injected transport is still honoured (the existing test seam)', async () => {
    configurePdfParser({ eventId: 'evt_1', getToken: null })     // no token source at all…
    let seen = ''
    const parser = createPdfParser(async url => { seen = url; return new Response(JSON.stringify(okBody), { status: 200 }) })
    const out = await parser.parse(file)
    expect(out.ok).toBe(true)                                     // …and the injected post did not need one
    expect(seen).toContain('parse-pdf')
    expect(captured).toBeNull()                                   // global fetch was never touched
  })

  it('5 · no token ⇒ no request, and the organizer is told about their session', async () => {
    configurePdfParser({ eventId: 'evt_1', getToken: async () => null })
    const out = await createPdfParser().parse(file)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toBe(PDF_SESSION_EXPIRED)
    expect(captured, 'an anonymous request must never be sent').toBeNull()

    configurePdfParser({ eventId: 'evt_1', getToken: null })
    await expect(authenticatedPost('/x', PDF_BYTES)).rejects.toThrow(PDF_SESSION_EXPIRED)
    expect(captured).toBeNull()
  })

  it('the token never appears in the URL, and the event never comes from the file', async () => {
    configurePdfParser({ eventId: 'evt_1', getToken: async () => 'SECRET' })
    await createPdfParser().parse(file)
    expect(captured!.url.includes('SECRET')).toBe(false)
    expect(captured!.url.includes('token')).toBe(false)
  })
})

// Assertion 6 — the ROUTE refusing an unauthenticated request with 401 — lives in
// tests/emulator/resultsPdfImport.emu.test.ts: importing the route initialises
// firebase-admin, which the plain unit environment cannot do.
