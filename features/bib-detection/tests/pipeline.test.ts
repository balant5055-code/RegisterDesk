// RD-BIB-01 — the provider contract, the retry rules, and the invariants that cannot be
// checked by reading a single function.
//
// The last block is a STATIC test of the import graph. "A photo is never matched against a
// draft import" is claimed as a structural property rather than a policy, so it is checked
// structurally: if any file in this module ever imports the draft repositories, the test
// fails, whatever the comments say.

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { FakeProvider } from '@/features/ai/tests/fakeProvider'
import {
  getResultConsumer, registerResultConsumer, registeredConsumerKinds, resetResultConsumers,
} from '@/features/ai/services/consumers'
import { resetRuntimeProviders, registerProvider, resolveProvider } from '@/features/ai/providers'
import { decideFailureAction } from '@/features/ai/queue/stateMachine'
import { AIError, toAIError } from '@/features/ai/types/errors'
import { BIB_DETECT_KIND } from '@/features/bib-detection/types'
import { parseDetectionPayload } from '@/features/bib-detection/utils/payload'
import { decideMatches } from '@/features/bib-detection/matching/matcher'

beforeEach(() => { resetRuntimeProviders(); resetResultConsumers() })

/** A provider that speaks the bib-detection payload contract and nothing else. */
const bibProvider = (detections: unknown[]) => new FakeProvider({
  id: 'fake-bib',
  kinds: [BIB_DETECT_KIND],
  output: { payload: { detections }, confidence: null, providerVersion: 'bib-v1' },
})

const IMAGE = {
  assetId: 'med_1', key: 'events/e/photos/medium/o1',
  signedUrl: 'https://signed.example/o1', mimeType: 'image/jpeg',
  width: 1600, height: 1067,
}

/** The AIError a provider threw, normalised exactly as the dispatcher normalises it. */
async function failureOf(provider: FakeProvider): Promise<AIError> {
  try {
    await provider.analyze({ kind: BIB_DETECT_KIND, image: IMAGE })
  } catch (e) {
    return toAIError(e)
  }
  throw new Error('expected the provider to throw')
}

// ═══════════════ The provider contract ═══════════════

describe('the Sprint 8 provider interface is reused unchanged', () => {
  it('a bib provider registers and resolves for its kind', () => {
    registerProvider(bibProvider([]))
    expect(resolveProvider(BIB_DETECT_KIND)?.id).toBe('fake-bib')
  })

  it('does not serve any other kind', () => {
    registerProvider(bibProvider([]))
    for (const kind of ['face-match', 'ocr', 'object-detect']) {
      expect(resolveProvider(kind), kind).toBeNull()
    }
  })

  it('returns only bib, confidence and box — the pipeline reads nothing else', async () => {
    const provider = bibProvider([
      { bibNumber: '101', confidence: 0.95, boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
    ])
    const out = await provider.analyze({ kind: BIB_DETECT_KIND, image: IMAGE })
    const { payload } = parseDetectionPayload(out.payload)

    expect(payload.detections).toHaveLength(1)
    expect(Object.keys(payload.detections[0]).sort())
      .toEqual(['bibKey', 'bibNumber', 'boundingBox', 'confidence'])
    expect(out.providerVersion).toBe('bib-v1')
  })

  it('is handed a signed URL and no credentials', async () => {
    const provider = bibProvider([])
    await provider.analyze({ kind: BIB_DETECT_KIND, image: IMAGE })
    expect(provider.calls[0].image.signedUrl).toBe('https://signed.example/o1')
    expect(Object.keys(provider.calls[0].image)).not.toContain('bytes')
  })

  it('an unconfigured bib provider is never resolved', () => {
    registerProvider(new FakeProvider({ id: 'fake-bib', kinds: [BIB_DETECT_KIND], configured: false }))
    expect(resolveProvider(BIB_DETECT_KIND)).toBeNull()
  })
})

// ═══════════════ Provider output → decision, end to end (pure half) ═══════════════

describe('provider output flows through parsing into decisions', () => {
  it('one bib, one published runner → matched', async () => {
    const out = await bibProvider([{ bibNumber: '101', confidence: 0.95 }])
      .analyze({ kind: BIB_DETECT_KIND, image: IMAGE })
    const { payload } = parseDetectionPayload(out.payload)

    const decisions = decideMatches(payload.detections.map(detection => ({
      detection,
      candidates: [{ passId: '10k', passSlug: '10-km', passName: '10 KM', snapshotVersion: 1 }],
    })))

    expect(decisions).toHaveLength(1)
    expect(decisions[0].matchStatus).toBe('matched')
    expect(decisions[0].detection.confidence).toBe(0.95)
  })

  it('several bibs in one frame produce several decisions', async () => {
    const out = await bibProvider([
      { bibNumber: '101', confidence: 0.9 },
      { bibNumber: '202', confidence: 0.8 },
      { bibNumber: '303', confidence: 0.7 },
    ]).analyze({ kind: BIB_DETECT_KIND, image: IMAGE })

    const { payload } = parseDetectionPayload(out.payload)
    const decisions = decideMatches(payload.detections.map(detection => ({ detection, candidates: [] })))
    expect(decisions).toHaveLength(3)
    expect(decisions.every(d => d.matchStatus === 'unmatched')).toBe(true)
  })

  it('a chatty provider contributes nothing extra to the decision', async () => {
    const out = await bibProvider([
      { bibNumber: '101', confidence: 0.9, faceEmbedding: [1, 2], personName: 'Priya Sharma' },
    ]).analyze({ kind: BIB_DETECT_KIND, image: IMAGE })

    const { payload } = parseDetectionPayload(out.payload)
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toContain('Priya')
    expect(serialised).not.toContain('faceEmbedding')
  })
})

// ═══════════════ Retry and failure ═══════════════

describe('failure is classified by the Sprint 8 rules, not by this feature', () => {
  it('a rate-limited provider is retried while budget remains', async () => {
    const provider = new FakeProvider({
      id: 'fake-bib', kinds: [BIB_DETECT_KIND],
      throws: new AIError('RATE_LIMITED', 'slow down'),
    })
    const err = await failureOf(provider)

    expect(err.code).toBe('RATE_LIMITED')
    expect(err.retryable).toBe(true)
    expect(decideFailureAction({ attempt: 1, maxAttempts: 3, retryable: err.retryable }))
      .toBe('scheduleRetry')
  })

  it('gives up once the attempt budget is spent', async () => {
    const err = new AIError('TIMEOUT', 'too slow')
    expect(decideFailureAction({ attempt: 3, maxAttempts: 3, retryable: err.retryable })).toBe('fail')
  })

  it('a rejected image is NOT retried — retrying would burn quota for the same answer', async () => {
    const provider = new FakeProvider({
      id: 'fake-bib', kinds: [BIB_DETECT_KIND],
      throws: new AIError('PROVIDER_REJECTED', 'unsupported image'),
    })
    const err = await failureOf(provider)

    expect(err.retryable).toBe(false)
    expect(decideFailureAction({ attempt: 1, maxAttempts: 5, retryable: err.retryable })).toBe('fail')
  })

  it('a raw vendor error is normalised and truncated before it can reach a job document', async () => {
    const provider = new FakeProvider({
      id: 'fake-bib', kinds: [BIB_DETECT_KIND],
      throws: new Error('x'.repeat(4000)),
    })
    const err = await failureOf(provider)
    expect(err.code).toBe('PROVIDER_ERROR')
    expect(err.message.length).toBe(300)
  })
})

// ═══════════════ The capability registry ═══════════════

describe('the dispatcher reaches this feature through a registry, not an if', () => {
  it('a consumer registered for the bib kind is the one resolved', async () => {
    let seen = 0
    registerResultConsumer(BIB_DETECT_KIND, async () => { seen++ })

    const consumer = getResultConsumer(BIB_DETECT_KIND)
    expect(consumer).not.toBeNull()
    await consumer?.({} as never)
    expect(seen).toBe(1)
  })

  it('an unregistered kind resolves to nothing, and the dispatcher simply skips it', () => {
    registerResultConsumer(BIB_DETECT_KIND, async () => {})
    expect(getResultConsumer('something-else')).toBeNull()
    expect(registeredConsumerKinds()).toEqual([BIB_DETECT_KIND])
  })
})

// ═══════════════ The import graph ═══════════════

describe('draft imports are structurally unreachable from this module', () => {
  const moduleRoot = path.join(process.cwd(), 'features', 'bib-detection')

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })

  const files = sourceFiles(moduleRoot)

  it('finds the module to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  /** Every module specifier a file imports. Comments explain what is NOT done, so only the
   *  imports themselves can prove what is reachable. */
  const importsOf = (source: string): string[] =>
    [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(m => m[1])

  it('never imports the draft session or result repositories', () => {
    // The Official Snapshot is the ONLY read model for matching. These are the two
    // repositories that can see unpublished rows.
    const forbidden = ['sessionRepo', 'resultRepo', 'importService']
    for (const file of files) {
      const rel = path.relative(moduleRoot, file)
      for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
        for (const bad of forbidden) {
          expect(spec.includes(bad), `${rel} imports ${spec}`).toBe(false)
        }
      }
    }
  })

  it('reaches race results ONLY through the snapshot repository and its pure helpers', () => {
    const raceImports = files.flatMap(file =>
      importsOf(fs.readFileSync(file, 'utf8')).filter(s => s.includes('race-operations')),
    )
    expect(raceImports.length).toBeGreaterThan(0)
    for (const spec of new Set(raceImports)) {
      expect(
        spec.includes('snapshotRepo') || spec.includes('types/snapshot') || spec.includes('utils/publicKeys'),
        `unexpected race-operations import: ${spec}`,
      ).toBe(true)
    }
  })

  it('never mentions a face, a person or generic OCR', () => {
    // Not a style rule: a field for any of these is how one would get stored.
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').toLowerCase()
      const rel = path.relative(moduleRoot, file)
      // Comments explain what is NOT done, so only look at what the code declares: an
      // interface member, an object key, or a property read.
      for (const banned of ['faceembedding', 'facebox', 'personid', 'landmarks']) {
        expect(source.includes(`${banned}:`), `${rel} declares ${banned}`).toBe(false)
        expect(source.includes(`.${banned}`), `${rel} reads ${banned}`).toBe(false)
      }
    }
  })
})
