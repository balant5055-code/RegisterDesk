// RD-AI-01 · A fake AIProvider for tests.
//
// The provider contract is what the whole module is built around, so it needs something to
// be proven against. This is that something — the same device `platform-storage` uses with
// `fakeProvider.ts`, and the reason "no provider is implemented" does not mean "the
// interface is untested".
//
// TEST-ONLY. It is not exported from the module barrel and is never registered outside a
// test file.

import { AIError } from '@/features/ai/types/errors'
import type {
  AIAnalyzeInput, AIAnalyzeOutput, AIProvider,
} from '@/features/ai/providers/AIProvider'
import type { AIJobKind } from '@/features/ai/types'

export interface FakeProviderOptions {
  id?:         string
  configured?: boolean
  kinds?:      readonly AIJobKind[]
  /** Thrown by `analyze` instead of returning. */
  throws?:     Error
  /** Overrides the default payload. */
  output?:     AIAnalyzeOutput
  /** `isConfigured` throws — a broken provider must not take the pipeline down. */
  configThrows?: boolean
}

export class FakeProvider implements AIProvider {
  readonly id:   string
  readonly name = 'Fake Provider'

  /** Every input `analyze` was called with, in order. */
  readonly calls: AIAnalyzeInput[] = []

  private readonly opts: FakeProviderOptions

  constructor(opts: FakeProviderOptions = {}) {
    this.opts = opts
    this.id   = opts.id ?? 'fake'
  }

  isConfigured(): boolean {
    if (this.opts.configThrows) throw new Error('configuration exploded')
    return this.opts.configured ?? true
  }

  kinds(): readonly AIJobKind[] {
    return this.opts.kinds ?? ['fake-analysis']
  }

  supports(kind: AIJobKind): boolean {
    return this.kinds().includes(kind)
  }

  async analyze(input: AIAnalyzeInput): Promise<AIAnalyzeOutput> {
    this.calls.push(input)
    if (this.opts.throws) throw this.opts.throws
    if (!input.image.signedUrl) {
      throw new AIError('INVALID_INPUT', 'A provider must be given a signed URL.')
    }
    return this.opts.output ?? {
      payload:         { echoedKind: input.kind, assetId: input.image.assetId },
      confidence:      0.5,
      providerVersion: 'fake-1',
    }
  }
}
