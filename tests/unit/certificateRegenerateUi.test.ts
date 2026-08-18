// GA-4 S2 — the certificate REGENERATION surface.
//
// THE DEFECT THIS PINS. The regenerate engine and its route shipped in "Release Phase 2" and
// then sat unreachable: `git log -S"certificates/regenerate"` across all history returned zero
// commits touching any component. An organizer could not regenerate a certificate at all, and
// the closest visible action — Issue — is idempotent per (eventId, registrationId,
// certificateType), so using it instead silently returns the OLD certificate and looks like
// success. That substitution is the single most expensive mistake available here, so it is
// asserted directly.
//
// The API client is exercised at RUNTIME with a stubbed fetch. The panel is read as TEXT,
// the idiom established by certificatePhotoCenterWiring.test.ts — this repository runs Vitest
// in the `node` environment with no jsdom and no React Testing Library.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeCertApi } from '@/components/certificates/hub/api'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** Strips comments so the explanatory notes in these files are not false positives. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const PANEL = 'components/certificates/hub/RecipientsPanel.tsx'
const EVENT = 'k31aQSYy0LQd9JhFDUUG'
const CERT  = 'RDC-2026-19BAKP'

// ─── API client, at runtime ───────────────────────────────────────────────────

interface Call { url: string; init?: RequestInit }
const calls: Call[] = []

function stubFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
  })
}

beforeEach(() => { calls.length = 0; vi.unstubAllGlobals() })

describe('api.regenerate targets the regeneration endpoint', () => {
  it('1 · POSTs to /certificates/regenerate for this event', async () => {
    stubFetch({ succeeded: 1, failed: 0, results: [{ certificateId: CERT, ok: true }] })
    await makeCertApi(EVENT, 'tok').regenerate([CERT])

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`/api/organizer/events/${EVENT}/certificates/regenerate`)
    expect(calls[0].init?.method).toBe('POST')
  })

  it('2 · sends exactly { certificateIds: [...] }', async () => {
    stubFetch({ succeeded: 1, failed: 0, results: [{ certificateId: CERT, ok: true }] })
    await makeCertApi(EVENT, 'tok').regenerate([CERT])

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body).toEqual({ certificateIds: [CERT] })
  })

  it('3 · NEVER calls the issue/generate endpoint', async () => {
    stubFetch({ succeeded: 1, failed: 0, results: [{ certificateId: CERT, ok: true }] })
    await makeCertApi(EVENT, 'tok').regenerate([CERT])

    // Issue is idempotent per (eventId, registrationId, certificateType) — calling it here
    // would return the existing certificate unchanged and report success.
    for (const c of calls) {
      expect(c.url).not.toMatch(/\/issue\b/)
      expect(c.url).not.toMatch(/\/generate\b/)
    }
  })

  it('11 · passes the certificate id through unchanged', async () => {
    stubFetch({ succeeded: 1, failed: 0, results: [{ certificateId: CERT, ok: true }] })
    await makeCertApi(EVENT, 'tok').regenerate([CERT])
    const body = JSON.parse(String(calls[0].init?.body)) as { certificateIds: string[] }
    expect(body.certificateIds[0]).toBe(CERT)
  })

  it('12 · sends no registrationId or participant id', async () => {
    stubFetch({ succeeded: 1, failed: 0, results: [{ certificateId: CERT, ok: true }] })
    await makeCertApi(EVENT, 'tok').regenerate([CERT])
    const raw = String(calls[0].init?.body)
    expect(raw).not.toMatch(/registrationId/i)
    expect(raw).not.toMatch(/participant/i)
  })

  it('6 · bulk sends exactly the ids given, in order', async () => {
    const ids = ['RDC-2026-AAAAAA', 'RDC-2026-BBBBBB', 'RDC-2026-CCCCCC']
    stubFetch({ succeeded: 3, failed: 0, results: ids.map(certificateId => ({ certificateId, ok: true })) })
    await makeCertApi(EVENT, 'tok').regenerate(ids)

    const body = JSON.parse(String(calls[0].init?.body)) as { certificateIds: string[] }
    expect(body.certificateIds).toEqual(ids)
  })

  it('carries the organizer Bearer token, like every other mutating call', async () => {
    stubFetch({ succeeded: 1, failed: 0, results: [{ certificateId: CERT, ok: true }] })
    await makeCertApi(EVENT, 'tok').regenerate([CERT])
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
  })

  it('returns the route’s own shape, including per-item failures', async () => {
    stubFetch({
      succeeded: 1, failed: 1,
      results: [
        { certificateId: 'RDC-2026-AAAAAA', ok: true },
        { certificateId: 'RDC-2026-BBBBBB', ok: false, error: 'no_active_template' },
      ],
    })
    const r = await makeCertApi(EVENT, 'tok').regenerate(['RDC-2026-AAAAAA', 'RDC-2026-BBBBBB'])
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.results[1].error).toBe('no_active_template')
  })
})

// ─── Panel wiring, as source ──────────────────────────────────────────────────

describe('the Recipients panel surfaces regeneration', () => {
  const src = code(read(PANEL))

  it('4 · a row action exists and opens the confirmation rather than firing immediately', () => {
    expect(src).toMatch(/title="Regenerate"/)
    // The click must stage the id for confirmation — never call the API directly.
    expect(src).toMatch(/onClick=\{\(\) => setRegenerating\(\[c\.certificateId\]\)\}/)
  })

  it('5 · the row action is not offered for a revoked certificate', () => {
    // Rendered inside a `!revoked &&` guard, immediately before the Restore/Revoke pair.
    const i = src.indexOf('title="Regenerate"')
    expect(i).toBeGreaterThan(-1)
    const before = src.slice(Math.max(0, i - 400), i)
    expect(before).toMatch(/\{!revoked && \(/)
  })

  it('6 · the bulk action passes the selected certificate ids', () => {
    expect(src).toMatch(/Regenerate \{selected\.size\} selected/)
    expect(src).toMatch(/setRegenerating\(\[\.\.\.selected\]\)/)
  })

  it('7 · confirmation is required — the dialog owns the only call site', () => {
    expect(src).toMatch(/<RegenerateDialog/)
    expect(src).toMatch(/onConfirm=\{\(\) => void runRegenerate\(regenerating\)\}/)
    // runRegenerate is reachable from the dialog only.
    expect(src.match(/runRegenerate\(/g) ?? []).toHaveLength(2)   // definition + dialog callback
  })

  it('8/9 · success is derived from results[].ok, never from the HTTP status', () => {
    expect(src).toMatch(/const failures = r\.results\.filter\(x => !x\.ok\)/)
    expect(src).toMatch(/if \(failures\.length === 0\)/)
    // The route answers 200 on total failure; res.ok must not be the success signal.
    expect(src).not.toMatch(/res\.ok\s*\?\s*['"`]Certificate regenerated/)
  })

  it('10 · the per-item error is surfaced', () => {
    expect(src).toMatch(/f\.error \?\? 'failed'/)
    expect(src).toMatch(/failures\[0\]\.error \?\? 'unknown error'/)
  })

  it('does not reimplement storage, signing or artifact logic in the client', () => {
    for (const forbidden of ['getDownloadURL', 'uploadBytes', 'firebase/storage', 'generateSignedUrl', 'buildObjectKey']) {
      expect(src, forbidden).not.toContain(forbidden)
    }
  })

  it('leaves the existing delivery actions untouched', () => {
    expect(src).toMatch(/Send all not sent/)
    expect(src).toMatch(/Retry failed/)
    expect(src).toMatch(/Send \{selected\.size\} selected/)
  })

  it('refreshes through the existing loader after regenerating', () => {
    expect(src).toMatch(/await loadFirst\(\)/)
  })
})

// ─── RD-CERT-UX · per-row action loading states ───────────────────────────────
//
// WHAT WAS WRONG. Three overlapping flags described "something is happening": `busyId` held a
// single certificate id with no action identity, so a spinner could not say whether the row
// was sending or regenerating; `regenBusy` and `deleteBusy` were module-wide booleans, so
// starting either one greyed that action out on EVERY row. Download had no guard at all, so a
// double-click issued two signed-URL requests and opened two tabs.

describe('every recipient action reports its own progress', () => {
  const src = code(read(PANEL))

  it('models the running action per row, not as a global flag', () => {
    expect(src).toMatch(/rowBusy, setRowBusy\] = useState<Record<string, RowAction>>/)
    // The flags that could not distinguish rows or actions are gone.
    expect(src).not.toMatch(/const \[busyId/)
  })

  it('names a distinct label for each action', () => {
    for (const [action, label] of [
      ['download', 'Preparing…'], ['send', 'Sending…'], ['retry', 'Retrying…'],
      ['regenerate', 'Generating…'], ['revoke', 'Revoking…'], ['delete', 'Deleting…'],
    ]) {
      expect(src, action).toContain(label)
    }
  })

  it('scopes disabling to the row that is working', () => {
    // `busy` is derived per row inside the map; a global would disable unrelated rows.
    expect(src).toMatch(/const busy\s+= rowBusy\[c\.certificateId\]/)
    expect(src).toMatch(/disabled=\{!!busy\}/)

    // Scoped to the ROW cluster. The toolbar's bulk buttons legitimately still gate on
    // regenBusy/deleteBusy — those describe the batch operation, not one row — so asserting
    // over the whole file would fail against correct code.
    const rows = src.slice(src.indexOf('{rows.map(c => {'), src.indexOf('</tbody>'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).not.toMatch(/regenBusy|deleteBusy|busyId/)
  })

  it('guards against a duplicate submission before the disabled state paints', () => {
    // React state is asynchronous, so a fast second click can dispatch before `disabled`
    // renders. The handler itself has to refuse the second run.
    const fn = src.slice(src.indexOf('async function act('), src.indexOf('function markRows'))
    expect(fn).toMatch(/if \(already\) return/)
  })

  it('restores the action on failure instead of stranding a spinner', () => {
    const fn = src.slice(src.indexOf('async function act('), src.indexOf('function markRows'))
    expect(fn).toMatch(/finally\s*\{/)
    expect(fn).toMatch(/delete next\[id\]/)
  })

  it('gives Download a guard it previously lacked', () => {
    const btn = src.slice(src.indexOf('title="Download"'), src.indexOf('title="Download"') + 400)
    expect(btn).toMatch(/disabled=\{!!busy\}/)
    expect(btn).toMatch(/busy === 'download'/)
  })

  it('marks every affected row during a BULK regenerate or delete', () => {
    expect(src).toMatch(/markRows\(ids, 'regenerate'\)/)
    expect(src).toMatch(/markRows\(ids, 'delete'\)/)
    expect(src).toMatch(/markRows\(ids, null\)/)
  })

  it('uses no artificial delay and no fabricated progress', () => {
    expect(src).not.toMatch(/setTimeout|setInterval\(\s*\(\)\s*=>\s*setProgress/)
    expect(src).not.toMatch(/fakeProgress|simulateProgress/)
  })

  it('never navigates or reloads to reflect an action', () => {
    expect(src).not.toMatch(/window\.location\.reload|router\.refresh\(\)/)
  })
})
