// RD-AI-01 — the provider contract and registry.
//
// This sprint implements NO provider, so the first test here is the one that proves it:
// with nothing registered, the pipeline reports itself unconfigured and resolves nothing.
// The rest exercise the contract against a fake, so "no implementation" does not mean
// "unverified interface".

import { describe, it, expect, beforeEach } from 'vitest'
import {
  KNOWN_AI_PROVIDER_IDS, allProviders, configuredProviders, getProviderById,
  isPipelineConfigured, registerProvider, resetRuntimeProviders, resolveProvider,
  supportedKinds, unregisterProvider,
} from '@/features/ai/providers'
import { FakeProvider } from '@/features/ai/tests/fakeProvider'
import { AIError, aiErrorStatus, isRetryableCode, toAIError } from '@/features/ai/types/errors'

beforeEach(() => { resetRuntimeProviders() })

// ═══════════════ The sprint's central claim ═══════════════

describe('no provider is implemented', () => {
  it('the registry is empty', () => {
    expect(allProviders()).toEqual([])
    expect(configuredProviders()).toEqual([])
  })

  it('the pipeline reports itself unconfigured', () => {
    expect(isPipelineConfigured()).toBe(false)
    expect(supportedKinds()).toEqual([])
  })

  it('nothing resolves for any kind', () => {
    for (const kind of ['bib-detect', 'face-match', 'ocr', 'anything']) {
      expect(resolveProvider(kind), kind).toBeNull()
    }
  })

  it('names the intended providers without implementing one', () => {
    expect([...KNOWN_AI_PROVIDER_IDS]).toEqual(['gemini', 'openai', 'aws'])
    for (const id of KNOWN_AI_PROVIDER_IDS) {
      expect(getProviderById(id), id).toBeNull()
    }
  })
})

// ═══════════════ Registration ═══════════════

describe('registration', () => {
  it('a registered, configured provider becomes resolvable', () => {
    registerProvider(new FakeProvider({ kinds: ['thing'] }))
    expect(isPipelineConfigured()).toBe(true)
    expect(resolveProvider('thing')?.id).toBe('fake')
    expect(supportedKinds()).toEqual(['thing'])
  })

  it('an UNCONFIGURED provider is registered but never resolved', () => {
    // Half-configured is the normal state of a new deployment: the code ships before the
    // key does, and the queue must refuse work rather than accept it and fail every job.
    registerProvider(new FakeProvider({ configured: false, kinds: ['thing'] }))
    expect(allProviders()).toHaveLength(1)
    expect(configuredProviders()).toEqual([])
    expect(resolveProvider('thing')).toBeNull()
    expect(isPipelineConfigured()).toBe(false)
  })

  it('a provider whose isConfigured() throws is treated as unconfigured, not fatal', () => {
    registerProvider(new FakeProvider({ configThrows: true }))
    expect(() => configuredProviders()).not.toThrow()
    expect(configuredProviders()).toEqual([])
  })

  it('re-registering the same id replaces rather than duplicates', () => {
    registerProvider(new FakeProvider({ id: 'dup', kinds: ['a'] }))
    registerProvider(new FakeProvider({ id: 'dup', kinds: ['b'] }))
    expect(allProviders()).toHaveLength(1)
    expect(supportedKinds()).toEqual(['b'])
  })

  it('unregistering removes it', () => {
    registerProvider(new FakeProvider({ id: 'temp' }))
    unregisterProvider('temp')
    expect(getProviderById('temp')).toBeNull()
  })

  it('resolves in registration order, deterministically', () => {
    // Not "best" or "cheapest" — the platform has no cost or quality data, and an operator
    // can reason about a fixed order.
    registerProvider(new FakeProvider({ id: 'first',  kinds: ['shared'] }))
    registerProvider(new FakeProvider({ id: 'second', kinds: ['shared'] }))
    for (let i = 0; i < 5; i++) expect(resolveProvider('shared')?.id).toBe('first')
  })

  it('skips a provider that does not support the kind', () => {
    registerProvider(new FakeProvider({ id: 'a', kinds: ['x'] }))
    registerProvider(new FakeProvider({ id: 'b', kinds: ['y'] }))
    expect(resolveProvider('y')?.id).toBe('b')
    expect(resolveProvider('z')).toBeNull()
  })

  it('merges kinds across providers and sorts them', () => {
    registerProvider(new FakeProvider({ id: 'a', kinds: ['zeta', 'alpha'] }))
    registerProvider(new FakeProvider({ id: 'b', kinds: ['alpha', 'mid'] }))
    expect(supportedKinds()).toEqual(['alpha', 'mid', 'zeta'])
  })
})

// ═══════════════ The contract ═══════════════

describe('the AIProvider contract', () => {
  it('returns a payload, a confidence and its own version', async () => {
    const provider = new FakeProvider({ kinds: ['thing'] })
    const out = await provider.analyze({
      kind:  'thing',
      image: {
        assetId: 'med_1', key: 'events/e/photos/medium/o1',
        signedUrl: 'https://signed.example/o1', mimeType: 'image/jpeg',
        width: 1600, height: 1067,
      },
    })
    expect(out.payload).toEqual({ echoedKind: 'thing', assetId: 'med_1' })
    expect(out.confidence).toBe(0.5)
    expect(out.providerVersion).toBe('fake-1')
  })

  it('is given a signed URL and nothing else — no bytes, no credentials', async () => {
    const provider = new FakeProvider()
    await provider.analyze({
      kind:  'fake-analysis',
      image: {
        assetId: 'med_1', key: 'events/e/photos/medium/o1',
        signedUrl: 'https://signed.example/o1', mimeType: 'image/jpeg',
        width: null, height: null,
      },
    })
    const image = provider.calls[0].image as unknown as Record<string, unknown>
    expect(Object.keys(image).sort()).toEqual(
      ['assetId', 'height', 'key', 'mimeType', 'signedUrl', 'width'],
    )
    expect(image.body).toBeUndefined()
    expect(image.bytes).toBeUndefined()
  })

  it('supports() and kinds() agree', () => {
    const provider = new FakeProvider({ kinds: ['a', 'b'] })
    for (const k of provider.kinds()) expect(provider.supports(k)).toBe(true)
    expect(provider.supports('c')).toBe(false)
  })
})

// ═══════════════ Errors — the language the queue retries on ═══════════════

describe('AIError', () => {
  it('marks transient failures retryable and permanent ones not', () => {
    expect(isRetryableCode('RATE_LIMITED')).toBe(true)
    expect(isRetryableCode('TIMEOUT')).toBe(true)
    expect(isRetryableCode('PROVIDER_ERROR')).toBe(true)

    expect(isRetryableCode('INVALID_INPUT')).toBe(false)
    expect(isRetryableCode('PROVIDER_REJECTED')).toBe(false)
    expect(isRetryableCode('NOT_FOUND')).toBe(false)
    expect(isRetryableCode('NO_PROVIDER')).toBe(false)
  })

  it('derives retryability from the code, and lets a caller override it', () => {
    expect(new AIError('TIMEOUT', 'slow').retryable).toBe(true)
    expect(new AIError('TIMEOUT', 'slow', { retryable: false }).retryable).toBe(false)
  })

  it('maps every code to a sane HTTP status', () => {
    expect(aiErrorStatus('NO_PROVIDER')).toBe(503)
    expect(aiErrorStatus('RATE_LIMITED')).toBe(429)
    expect(aiErrorStatus('NOT_FOUND')).toBe(404)
    expect(aiErrorStatus('INVALID_INPUT')).toBe(400)
    expect(aiErrorStatus('PROVIDER_ERROR')).toBe(502)
  })

  it('normalises a vendor error and TRUNCATES it', () => {
    // A job document is read by an organizer, and a provider's raw error body can echo
    // request content back.
    const err = toAIError(new Error('x'.repeat(5000)))
    expect(err.code).toBe('PROVIDER_ERROR')
    expect(err.message.length).toBe(300)
  })

  it('passes an AIError through unchanged', () => {
    const original = new AIError('RATE_LIMITED', 'slow down')
    expect(toAIError(original)).toBe(original)
  })

  it('normalises a thrown non-Error', () => {
    expect(toAIError('just a string').message).toBe('just a string')
  })
})
