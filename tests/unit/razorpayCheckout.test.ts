// MC-08.2 · The browser-side checkout launcher.
//
// One property matters here and it is not obvious: Razorpay fires `handler` and then closes
// the modal, which fires `ondismiss`. Without a latch a successful payment would be reported
// and then immediately overwritten by a cancellation — the shopper pays and the app says they
// backed out. The four hand-rolled copies in this repo each rediscovered this.
//
// Vitest runs in `node`, so `window`/`document` are stubbed to the minimum the module touches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface FakeOptions {
  handler: (r: unknown) => void
  modal?: { ondismiss?: () => void }
}

/** Captures the options the module passes, so the test can drive the callbacks itself. */
let captured: FakeOptions | null = null

function installGateway(behaviour: (o: FakeOptions) => void) {
  captured = null
  const scripts: unknown[] = []
  const g = globalThis as Record<string, unknown>

  g.window = {
    Razorpay: class {
      constructor(o: FakeOptions) { captured = o }
      open() { if (captured) behaviour(captured) }
    },
  }
  g.document = {
    querySelector: () => null,
    createElement: () => ({ addEventListener: () => {}, appendChild: () => {} }),
    body: { appendChild: (s: unknown) => { scripts.push(s) } },
  }
}

beforeEach(() => { vi.resetModules() })
afterEach(() => {
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.document
})

const REQ = { keyId: 'rzp_test_x', orderId: 'order_1', amountPaise: 50_000 }

async function open() {
  const { openRazorpayCheckout } = await import('@/lib/razorpay/checkout')
  return openRazorpayCheckout(REQ)
}

describe('openRazorpayCheckout', () => {
  it('reports a completed payment', async () => {
    installGateway(o => o.handler({
      razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: 'sig',
    }))
    const out = await open()
    expect(out.status).toBe('paid')
    if (out.status === 'paid') expect(out.payment.razorpay_payment_id).toBe('pay_1')
  })

  it('reports a dismissed modal as CANCELLED, not as an error', async () => {
    installGateway(o => o.modal?.ondismiss?.())
    expect((await open()).status).toBe('cancelled')
  })

  it('a dismiss AFTER a success does not overwrite the success', async () => {
    // The regression this latch exists for. Razorpay closes the modal once the payment
    // completes, so both callbacks fire for a single successful purchase.
    installGateway(o => {
      o.handler({
        razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: 'sig',
      })
      o.modal?.ondismiss?.()
    })
    expect((await open()).status).toBe('paid')
  })

  it('a second handler call cannot re-settle the promise', async () => {
    installGateway(o => {
      o.handler({
        razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: 'a',
      })
      o.handler({
        razorpay_payment_id: 'pay_2', razorpay_order_id: 'order_1', razorpay_signature: 'b',
      })
    })
    const out = await open()
    if (out.status === 'paid') expect(out.payment.razorpay_payment_id).toBe('pay_1')
  })

  it('reports UNAVAILABLE when the gateway never loads — distinct from a decline', async () => {
    const g = globalThis as Record<string, unknown>
    g.window = {}                                    // no Razorpay constructor, ever
    g.document = {
      querySelector: () => null,
      // The script "loads" but defines nothing.
      createElement: () => ({
        addEventListener: (ev: string, fn: () => void) => { if (ev === 'load') fn() },
      }),
      body: { appendChild: () => {} },
    }
    const out = await open()
    expect(out.status).toBe('unavailable')
    if (out.status === 'unavailable') expect(out.message.length).toBeGreaterThan(0)
  })

  it('passes the ORDER id through untouched — the charge is the order, not the amount', async () => {
    installGateway(o => o.modal?.ondismiss?.())
    await open()
    expect((captured as unknown as { order_id: string } | null)?.order_id).toBe('order_1')
  })
})
