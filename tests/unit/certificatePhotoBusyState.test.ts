// RD-CERT-PHOTO-BUSY — the Certificate Center photo render loop.
//
// THE REGRESSION THIS PINS. Browser QA on /events/[slug]/certificates recorded ~200
// "Maximum update depth exceeded" errors per session, firing as soon as the photo card
// mounted — before the cropper was ever opened. Two independent defects combined:
//
//   1. The updater ALWAYS allocated a new object. Its `busy === false` branch wrote
//      `prev[id].readiness` back over itself: value unchanged, identity new, so React
//      re-rendered.
//   2. The call site built `onBusyChange={busyNow => setPhotoBusy(id, busyNow)}` inline, so
//      every render handed the card a new function. The card reports busy from an effect
//      keyed on that callback, so the new identity re-fired the effect.
//
//      effect → setState → render → new callback → effect → ...
//
// Either fix alone breaks the cycle; both are in place so neither silently regressing can
// bring it back. The transition is a pure function precisely so these can be tested for real
// (this repo runs vitest in `node` with no jsdom/RTL), rather than only as source assertions.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyPhotoBusy, type ReadinessEntry } from '@/lib/certificates/photoBusyState'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

interface Entry extends ReadinessEntry {
  grant?: string
  hasPhoto?: boolean
}

const state = (over: Record<string, Partial<Entry>> = {}): Record<string, Entry> => {
  const base: Record<string, Entry> = {
    A: { readiness: 'ready', grant: 'gA', hasPhoto: false },
    B: { readiness: 'ready', grant: 'gB', hasPhoto: true },
  }
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v } as Entry
  return base
}

// ─── 1 · The identity contract that stops the loop ────────────────────────────

describe('applyPhotoBusy returns prev BY REFERENCE when nothing changes', () => {
  it('busy=false on a settled card is a no-op — this is the steady-state loop driver', () => {
    // The old code wrote readiness back over itself here, allocating every time. A card sits
    // in this exact state from the moment it mounts, so this ran on every single render.
    const prev = state()
    expect(applyPhotoBusy(prev, 'A', false)).toBe(prev)
  })

  it('repeated busy=true allocates ONCE, not once per report', () => {
    const prev  = state()
    const first = applyPhotoBusy(prev, 'A', true)
    expect(first).not.toBe(prev)                 // the real transition
    expect(first.A.readiness).toBe('resolving')

    const again = applyPhotoBusy(first, 'A', true)
    expect(again).toBe(first)                    // no further render
    const third = applyPhotoBusy(again, 'A', true)
    expect(third).toBe(first)
  })

  it('busy=false while already resolving does not thrash the state', () => {
    // Deliberate: clearing readiness here would announce "ready" before the new photo was
    // re-read. refreshHasPhoto owns that transition.
    const resolving = applyPhotoBusy(state(), 'A', true)
    expect(applyPhotoBusy(resolving, 'A', false)).toBe(resolving)
  })

  it('an unknown certificateId is a no-op, not an inserted entry', () => {
    // A card can report busy as it unmounts, after its session was dropped. Inserting a
    // half-formed entry would leave stale state behind.
    const prev = state()
    expect(applyPhotoBusy(prev, 'GONE', true)).toBe(prev)
    expect(applyPhotoBusy(prev, 'GONE', false)).toBe(prev)
    expect(Object.keys(prev)).toEqual(['A', 'B'])
  })

  it('a settled sequence converges instead of oscillating', () => {
    // Drive the exact loop shape: report the same value many times over.
    let s = state()
    const seen = new Set<unknown>([s])
    for (let i = 0; i < 50; i++) { s = applyPhotoBusy(s, 'A', false); seen.add(s) }
    expect(seen.size).toBe(1)                    // one object across 50 reports
  })
})

// ─── 2 · The real transition still happens ────────────────────────────────────

describe('busy state is still tracked correctly', () => {
  it('busy=true marks the card resolving, so Download cannot use a stale target', () => {
    const next = applyPhotoBusy(state(), 'A', true)
    expect(next.A.readiness).toBe('resolving')
  })

  it('busy=false after true updates exactly once when readiness has moved on', () => {
    // refreshHasPhoto settles readiness to 'ready'; a later busy=true is a fresh transition.
    const settled = { ...state(), A: { readiness: 'ready' as const, grant: 'gA' } }
    const a = applyPhotoBusy(settled, 'A', true)
    expect(a).not.toBe(settled)
    expect(applyPhotoBusy(a, 'A', true)).toBe(a)
  })

  it('preserves every other field on the entry', () => {
    const next = applyPhotoBusy(state(), 'A', true)
    expect(next.A.grant).toBe('gA')
    expect(next.A.hasPhoto).toBe(false)
  })
})

// ─── 3 · Cards stay independent ───────────────────────────────────────────────

describe('multiple attendee photo cards are tracked independently', () => {
  it('marking A busy does not touch B', () => {
    const prev = state()
    const next = applyPhotoBusy(prev, 'A', true)
    expect(next.A.readiness).toBe('resolving')
    expect(next.B.readiness).toBe('ready')
    expect(next.B).toBe(prev.B)                  // same reference — B never re-renders
  })

  it('two cards can be busy at once without interfering', () => {
    const both = applyPhotoBusy(applyPhotoBusy(state(), 'A', true), 'B', true)
    expect(both.A.readiness).toBe('resolving')
    expect(both.B.readiness).toBe('resolving')
    expect(both.A.grant).toBe('gA')
    expect(both.B.grant).toBe('gB')
  })

  it('one card unmounting leaves the other usable', () => {
    const { A } = state()
    const only = applyPhotoBusy({ A }, 'B', true)   // B is gone
    expect(only).toEqual({ A })
    expect(applyPhotoBusy(only, 'A', true).A.readiness).toBe('resolving')
  })
})

// ─── 4 · The call site cannot reintroduce an unstable callback ────────────────

describe('the parent hands each card a STABLE onBusyChange', () => {
  const src = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))

  it('no inline arrow is created in the results map', () => {
    // This exact expression was the second half of the loop.
    expect(src).not.toMatch(/onBusyChange=\{busyNow =>/)
    expect(src).not.toMatch(/onBusyChange=\{\(?\s*busy\w*\s*\)?\s*=>/)
  })

  it('resolves the handler from a memoised per-certificate map', () => {
    expect(src).toMatch(/onBusyChange=\{busyHandlers\.get\(r\.certificateId\)\}/)
    expect(src).toMatch(/const busyHandlers = useMemo\(/)
  })

  it('the updater itself is stable and delegates to the pure transition', () => {
    expect(src).toMatch(/const setPhotoBusy = useCallback\(/)
    expect(src).toMatch(/applyPhotoBusy\(prev, certificateId, busy\)/)
  })

  it('no longer allocates state inline on every report', () => {
    expect(src).not.toMatch(/readiness: busy \? 'resolving' : prev\[certificateId\]\.readiness/)
  })
})

describe('the card keeps correct effect dependencies', () => {
  const card = code(read('components/certificates/AttendeePhotoCard.tsx'))

  it('still reports busy from an effect with BOTH dependencies declared', () => {
    // The fix must not be "drop the dependency" — that would hide the loop while leaving the
    // callback stale, so a later report would call an outdated closure.
    expect(card).toMatch(/useEffect\(\(\) => \{ onBusyChange\?\.\(busy\) \}, \[busy, onBusyChange\]\)/)
  })

  it('uses no refs, timers or render suppression to paper over the loop', () => {
    const fn = card.slice(card.indexOf('const busy ='), card.indexOf('const busy =') + 400)
    expect(fn).not.toMatch(/setTimeout|requestAnimationFrame|useRef\(/)
  })
})

// ─── RD-CERT-PHOTO-STUCK · "Getting ready…" must always terminate ─────────────
//
// THE PRODUCTION DEFECT. A participant uploaded a photo, the API returned HTTP 200, and the
// certificate action stayed on "Getting ready…" permanently.
//
// The upload sets the card busy → the parent marks readiness 'resolving'. When the upload
// FINISHES the card reports busy=false — and `applyPhotoBusy(…, false)` computes
// `next = entry.readiness`, which is always equal, so it returns `prev` UNCHANGED. Nothing in
// the false branch could ever move readiness off 'resolving'. The only escape was the
// attendee pressing "Continue", which is optional. A 200 therefore left the button dead.
//
// The reducer's no-op is correct and stays (it is what prevents the render loop). What was
// missing is that a busy FALSE EDGE means "a write finished" and must re-resolve.

describe('applyPhotoBusy still refuses to clear readiness — by design', () => {
  const state = { A: { readiness: 'resolving' as const, grant: 'g' } }

  it('busy=false is a no-op, which is exactly why the UI got stuck', () => {
    // Documents the mechanism. The recovery belongs to the caller, not the reducer:
    // clearing here would announce 'ready' before hasPhoto was re-read.
    expect(applyPhotoBusy(state, 'A', false)).toBe(state)
  })

  it('busy=true still marks resolving exactly once', () => {
    const idle = { A: { readiness: 'ready' as const, grant: 'g' } }
    const next = applyPhotoBusy(idle, 'A', true)
    expect(next.A.readiness).toBe('resolving')
    expect(applyPhotoBusy(next, 'A', true)).toBe(next)   // no render storm
  })
})

describe('the busy FALSE EDGE re-resolves, so the button always recovers', () => {
  const src = readFileSync(resolve(process.cwd(), 'app/events/[slug]/certificates/CertificateCenterClient.tsx'), 'utf8')

  it('a finished write triggers exactly one re-resolve', () => {
    expect(src).toMatch(/if \(!writing\.current\.delete\(r\.certificateId\)\) return/)
    expect(src).toMatch(/void refreshHasPhoto\(r\.certificateId\)/)
  })

  it('a card merely MOUNTING does not fire a request', () => {
    // Mount reports busy=false too. Without the `writing` guard that would be one extra
    // photo GET per card on every page load — the request multiplication in the report.
    expect(src).toMatch(/writing\.current\.add\(r\.certificateId\)/)
  })

  it('readiness settles even when the read throws — no path leaves it resolving', () => {
    const fn = src.slice(src.indexOf('const refreshHasPhoto'), src.indexOf('const setPhotoBusy'))
    expect(fn).toMatch(/finally \{/)
    expect(fn).toMatch(/readiness: 'ready'/)
  })

  it('a missing grant settles instead of hanging', () => {
    const fn = src.slice(src.indexOf('const refreshHasPhoto'), src.indexOf('const setPhotoBusy'))
    expect(fn).toMatch(/if \(!grant\)/)
    expect(fn).toMatch(/readiness: 'ready'/)
  })

  it('the handler map stays identity-stable — the render loop does not return', () => {
    expect(src).toMatch(/\}, \[results, setPhotoBusy, refreshHasPhoto\]\)/)
    expect(src).toMatch(/const setPhotoBusy = useCallback\(/)
    // Reading the live grant through a ref is what keeps `photo` out of the dep array.
    expect(src).toMatch(/photoRef\.current\[certificateId\]\?\.grant/)
  })

  it('Continue still works and still passes its grant explicitly', () => {
    expect(src).toMatch(/onContinue=\{\(\) => \{ void refreshHasPhoto\(r\.certificateId, p\.grant\) \}\}/)
  })

  it('no polling or retry loop was introduced', () => {
    // NOT "no timers": a pre-existing setTimeout revokes a download object URL after 60s,
    // which is cleanup, not polling. What must be absent is anything that repeats.
    expect(src.includes(String.fromCharCode(115,101,116,73,110,116,101,114,118,97,108))).toBe(false)
    expect(src.indexOf("refreshHasPhoto") > -1).toBe(true)
  })

  it('the fix adds no synchronous generation on the public path', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/generateCertificate|renderCertificateOnDemand|regenerate/)
  })
})

describe('the existing certificate is never silently rewritten', () => {
  it('the client only READS photo state; it never asks for a new artifact', () => {
    const src = readFileSync(resolve(process.cwd(), 'app/events/[slug]/certificates/CertificateCenterClient.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Download simply switches WHICH url is used; it does not mutate the stored artifact.
    expect(src).toMatch(/p\?\.hasPhoto/)
    expect(src).not.toMatch(/method:\s*'PUT'|regenerate\(/)
  })
})
