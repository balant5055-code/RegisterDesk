// RD-EVENT-08 — the emit decision must be byte-identical to the pre-optimisation hook.
//
// This repo's vitest environment is `node` and there is no testing-library, so the hook
// itself cannot be mounted. Instead both implementations are driven through the SAME render
// sequence and their emissions compared.
//
// `legacyDriver` reproduces the original hook exactly:
//
//     const first   = useRef(true)
//     const dataRef = useRef(data)
//     const cbRef   = useRef(onAutosave)
//     useEffect(() => { dataRef.current = data; cbRef.current = onAutosave })
//     const json = JSON.stringify(data ?? null)
//     useEffect(() => {
//       if (first.current) { first.current = false; return }
//       cbRef.current?.(dataRef.current)
//     }, [json])
//
// The `[json]` dependency is what React compares between commits, so the legacy driver
// models it as "run the emit body only when json differs from the previous commit's json" —
// which is precisely what a dependency array does.

import { describe, it, expect } from 'vitest'
import {
  decideAutosaveEmit, autosaveSignature, type AutosaveSignature,
} from '@/lib/events/builder/autosaveChangeDetection'

/** One committed render. */
type Frame = unknown

/** Replays the ORIGINAL hook over a sequence of committed renders. */
function legacyDriver(frames: Frame[]): unknown[] {
  const emitted: unknown[] = []
  let first = true
  let prevJson: string | undefined      // undefined = no previous commit (deps never compared)
  let dataRef: unknown = frames[0]

  for (const data of frames) {
    // Effect 1 — declared first, so it runs first and refreshes the refs.
    dataRef = data
    // React compares the dep. Effect 2 runs on mount, and afterwards only when json differs.
    const json = JSON.stringify(data ?? null)
    const depChanged = prevJson === undefined || json !== prevJson
    prevJson = json
    if (depChanged) {
      if (first) { first = false; continue }
      emitted.push(dataRef)
    }
  }
  return emitted
}

/** Replays the RD-EVENT-08 hook over the same sequence. */
function currentDriver(frames: Frame[]): unknown[] {
  const emitted: unknown[] = []
  let signature: AutosaveSignature = null

  for (const data of frames) {
    const { emit, nextSignature } = decideAutosaveEmit(signature, data)
    signature = nextSignature
    if (emit) emitted.push(data)
  }
  return emitted
}

const bothAgree = (frames: Frame[]) =>
  expect(currentDriver(frames)).toEqual(legacyDriver(frames))

// ─── Realistic step payloads ─────────────────────────────────────────────────

const pass = (id: string, name: string, price: number) => ({
  id, name, pricePaise: price, description: '', maxQuantity: 100,
})
const pricing = (...names: string[]) => ({
  passes: names.map((n, i) => pass(`p${i}`, n, 50000 + i * 1000)),
  feeModel: 'organizer_pays',
})

describe('emit decisions are identical to the original hook', () => {
  it('mount alone never emits', () => {
    bothAgree([pricing('Early Bird')])
    expect(currentDriver([pricing('Early Bird')])).toEqual([])
  })

  it('one keystroke — a single content change emits once', () => {
    const frames = [pricing('E'), pricing('Ea')]
    bothAgree(frames)
    expect(currentDriver(frames)).toHaveLength(1)
  })

  it('typing 20 characters emits 20 times', () => {
    const word = 'Early Bird Marathon '
    const frames = Array.from({ length: word.length + 1 }, (_, i) => pricing(word.slice(0, i)))
    bothAgree(frames)
    expect(currentDriver(frames)).toHaveLength(word.length)
  })

  it('a re-render with a NEW object but identical content stays silent', () => {
    // The whole reason a signature exists: page-level re-renders reallocate step data.
    const frames = [pricing('Early'), pricing('Early'), pricing('Early')]
    bothAgree(frames)
    expect(currentDriver(frames)).toEqual([])
  })

  it('edit → revert → edit emits three times', () => {
    const frames = [pricing('A'), pricing('B'), pricing('A'), pricing('B')]
    bothAgree(frames)
    expect(currentDriver(frames)).toHaveLength(3)
  })

  it('emits the LATEST data, not a stale snapshot', () => {
    const frames = [pricing('A'), pricing('B')]
    expect(currentDriver(frames)[0]).toEqual(pricing('B'))
    expect(currentDriver(frames)).toEqual(legacyDriver(frames))
  })
})

describe('the comparator edge cases that a deep-equal rewrite would break', () => {
  // These are asserted so a future "cheaper comparator" sprint cannot land silently.

  it('KEY ORDER is significant — reordering emits', () => {
    const frames = [{ a: 1, b: 2 }, { b: 2, a: 1 }]
    bothAgree(frames)
    expect(currentDriver(frames)).toHaveLength(1)
  })

  it('undefined members are dropped — adding one does NOT emit', () => {
    const frames = [{ a: 1 }, { a: 1, b: undefined }]
    bothAgree(frames)
    expect(currentDriver(frames)).toEqual([])
  })

  it('null and undefined data are the same signature', () => {
    const frames = [null, undefined, null]
    bothAgree(frames)
    expect(currentDriver(frames)).toEqual([])
  })

  it('NaN collapses to null — NaN → null does NOT emit', () => {
    const frames = [{ n: NaN }, { n: null }]
    bothAgree(frames)
    expect(currentDriver(frames)).toEqual([])
  })

  it('array order is significant', () => {
    const frames = [{ f: ['a', 'b'] }, { f: ['b', 'a'] }]
    bothAgree(frames)
    expect(currentDriver(frames)).toHaveLength(1)
  })

  it('nested edits are detected', () => {
    const a = pricing('Early')
    const b = pricing('Early')
    b.passes[0].pricePaise = 99999
    bothAgree([a, b])
    expect(currentDriver([a, b])).toHaveLength(1)
  })
})

describe('signature function', () => {
  it('treats undefined as null, exactly as `data ?? null` did', () => {
    expect(autosaveSignature(undefined)).toBe('null')
    expect(autosaveSignature(null)).toBe('null')
  })

  it('first observation records a baseline without emitting', () => {
    const d = decideAutosaveEmit(null, { a: 1 })
    expect(d.emit).toBe(false)
    expect(d.nextSignature).toBe('{"a":1}')
  })

  it('an unchanged signature is returned so the caller can store it unconditionally', () => {
    const sig = autosaveSignature({ a: 1 })
    const d = decideAutosaveEmit(sig, { a: 1 })
    expect(d).toEqual({ emit: false, nextSignature: sig })
  })
})

describe('no missed saves and no duplicate saves over a long session', () => {
  it('emits exactly once per distinct consecutive content change', () => {
    // 200 frames: every 3rd is a real edit, the rest are identity-only re-renders.
    const frames: Frame[] = []
    let edits = 0
    for (let i = 0; i < 200; i++) {
      if (i % 3 === 0) edits++
      frames.push({ title: 'x'.repeat(edits) })
    }
    const out = currentDriver(frames)
    expect(out).toEqual(legacyDriver(frames))
    // The first frame is the baseline, so one fewer emit than distinct contents.
    expect(out).toHaveLength(edits - 1)
  })
})
