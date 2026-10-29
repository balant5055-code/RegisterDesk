// RD-LICENSE-LOCK-01 / RD-LICENSE-ZEROCAP-01 — the License & Services step's two reported defects.
//
// ═══ A · "Unlock to edit" did not lock everything ════════════════════════════
// A submitted event's purchase surface is documented as read-only until Unlock ("submitted mode
// starts LOCKED … ONE 'Unlock to edit' reveals every quantity control"). The media switch has
// always carried `disabled={locked}`; the WhatsApp and certificate switches did not. Their cards
// used `open={… && !locked}`, which collapses the card BODY — so the quantity selectors were
// protected while the toggles beside them stayed live, and `setFlag` persisted a flip instantly.
//
// ═══ B · a service switched ON with nothing to send ══════════════════════════
// WhatsApp ON + zero usable capacity + zero additional messages was reachable, and Done is a
// navigation that saves nothing, so the stale ON had already been written. It is now corrected
// on Done — but only with real coverage data, and only when nothing is left AND nothing added.
//
// These read source text: LicenseServicesStep is a client component whose module graph reaches
// Firestore and the quote API, so mounting it here would boot firebase-admin. The DECISIONS are
// structural — which control carries the gate, which condition the auto-off tests — and that is
// what the source states. Assertions run on comment-stripped source, because this file documents
// every string it asserts on.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const STEP = code(read('components/wizard/LicenseServicesStep.tsx'))
const PAGE = code(read('app/(dashboard)/dashboard/events/new/page.tsx'))

// ═══ A · THE LOCK ════════════════════════════════════════════════════════════

describe('RD-LICENSE-LOCK-01 · every service control obeys the lock', () => {
  it('derives the lock from submitted-and-not-editing, so a DRAFT is never locked', () => {
    // The unpublished-draft flow must be untouched: it has no lock and never did.
    expect(STEP).toContain('const locked = isSubmitted && !editing')
  })

  it('disables all three service switches — not just media', () => {
    // Each switch is matched with its own label so a shared `disabled` elsewhere cannot satisfy
    // this, and so a future fourth service is visibly missing rather than silently unguarded.
    for (const [service, anchor] of [
      ['whatsapp', "setFlag('whatsappEnabled', v)"],
      ['certificates', "setFlag('certEnabled', v)"],
    ] as const) {
      const at = STEP.indexOf(anchor)
      expect(at, `${service} switch not found`).toBeGreaterThan(-1)
      // The `disabled={locked}` sits on the same Switch element as the onChange.
      const element = STEP.slice(Math.max(0, at - 400), at + 200)
      expect(element, `${service} switch is not disabled while locked`).toContain('disabled={locked}')
    }
    // Media already had it and must keep it.
    expect(STEP).toContain('<Switch checked={mediaOpen && !locked} disabled={locked}')
  })

  it('refuses the WRITE while locked, so one missing attribute cannot reopen the hole', () => {
    // The per-control `disabled` is the affordance; this is the guard. setQty has always had
    // its equivalent (`if (!isSubmitted)`), which is why quantities were never exposed.
    const setFlag = STEP.slice(STEP.indexOf('const setFlag ='), STEP.indexOf('function setQty'))
    expect(setFlag).toContain('if (locked) return')
    expect(STEP).toContain('if (!isSubmitted) onServiceSelectionChange(next)')
  })

  it('reports the lock upward so the Fee Collection Method obeys it too', () => {
    // That control is rendered by the final step, OUTSIDE this component, and was added after
    // the lock existed — so it needs the flag passed to it rather than inferring one.
    // The flag is a member of the context the step reports upward (RD-PUBLISH-PLAN adds fields after it).
    expect(STEP).toMatch(/finalOnContext\?\.\(\{[^)]*\brefresh: refreshQuote, locked[,\s]/)
    expect(STEP).toMatch(/locked:\s+boolean/)
    // The exact expression is pinned by the fail-closed case below; here it is enough that the
    // page reads the reported flag at all rather than inferring a lock of its own.
    expect(PAGE).toMatch(/locked=\{[^}]*payCtx\?\.locked/)
    expect(PAGE).toContain('onClick={() => { if (!locked) onChange(opt.id) }}')
    expect(PAGE).toContain('disabled={locked}')
  })
})

// ═══ A2 · THE LOCK MUST FAIL CLOSED, AND THE MODEL MUST RE-SYNC ══════════════
//
// Two holes found by review of the first fix, both in the window before async state arrives.

describe('RD-LICENSE-LOCK-03 · the fee selector is locked while the lock state is UNKNOWN', () => {
  it('treats "not yet reported" as locked for a submitted event', () => {
    // `payCtx` starts null, so `payCtx?.locked === true` was false for the first render(s) and
    // a submitted event's fee options were briefly clickable before the lock arrived.
    expect(PAGE).toContain('locked={isSubmitted && payCtx?.locked !== false}')
    expect(PAGE).not.toContain('locked={payCtx?.locked === true}')
  })

  it('still leaves an unpublished draft unlocked', () => {
    // The guard is AND-ed with isSubmitted, so a draft can never be locked by an absent context.
    expect(PAGE).toContain('const isSubmitted        = isSubmittedDraftStatus(draftStatus)')
  })
})

describe('RD-FEE-RESTORE-04 · the displayed model re-syncs when its sources arrive', () => {
  it('derives the desired model and re-applies it when the inputs change', () => {
    // useState's initialiser runs ONCE. `pricingEngineOn` starts false (code defaults) and flips
    // after /api/config/public; `pricingData` arrives with the draft. Mounting before either
    // landed left the control showing the fallback for the rest of the session.
    expect(PAGE).toContain('const feeSourceKey = `${pricingEngineOn}|${recordedFeeModel ?? \'\'}`')
    expect(PAGE).toContain('if (feeSourceKey !== seenFeeSourceKey) {')
    expect(PAGE).toContain('setLocalFeeModel(desiredFeeModel)')
  })

  it('does NOT fight an in-flight save', () => {
    // A slow round trip must not snap the card back to the stored value mid-request.
    expect(PAGE).toContain('if (!feeResyncHold) setLocalFeeModel(desiredFeeModel)')
    expect(PAGE).toContain('setFeeResyncHold(true)')
    // Cleared in finally — a throw that left it set would freeze re-syncing for the session.
    expect(PAGE).toMatch(/finally \{[\s\S]{0,220}setFeeResyncHold\(false\)/)
    // STATE, not a ref: the hold is read during render, and React forbids reading a ref there.
    expect(PAGE).toContain('const [feeResyncHold, setFeeResyncHold] = useState(false)')
  })

  it('derives during render, not in an effect', () => {
    // An effect here would be the setState-in-effect cascade this file's lint rules reject;
    // LicenseServicesStep already uses the render-time compare for `grantKey`.
    const block = PAGE.slice(PAGE.indexOf('const feeSourceKey'), PAGE.indexOf('const feeSamplePrice'))
    expect(block).not.toContain('useEffect')
  })
})

// ═══ B · ON WITH NOTHING TO SEND ═════════════════════════════════════════════

describe('RD-LICENSE-ZEROCAP-01 · Done switches off a service that cannot run', () => {
  const goDone = STEP.slice(STEP.indexOf('const goDone ='), STEP.indexOf('const fm = submittedPurchaseFooter'))

  it('requires BOTH no usable capacity and no additional purchase', () => {
    // Either one alone must not switch anything off: an event with an existing allowance stays
    // on however little is being bought, which is the explicit requirement.
    expect(goDone).toContain('(coverage.remaining.whatsapp ?? 0) <= 0 && selection.whatsapp <= 0')
    expect(goDone).toContain('(coverage.remaining.certificates ?? 0) <= 0 && selection.certificates <= 0')
  })

  it('only acts on a service that is currently ON', () => {
    expect(goDone).toContain('payg.whatsappEnabled &&')
    expect(goDone).toContain('payg.certEnabled &&')
  })

  it('does NOTHING when coverage is unknown — a failed quote must not disable a live service', () => {
    // `coverage` is null while the quote loads and after a network error. Treating that as
    // "no capacity" would switch a working service off because a request failed.
    // Expressed as an early return now that Done awaits the persist: with no coverage there is
    // nothing to decide, so it navigates without touching a single flag.
    expect(goDone).toContain('if (!coverage) { router.push(ROUTES.DASHBOARD_EVENTS); return }')
  })

  it('changes the FLAG only — never purchased capacity or billing', () => {
    // Everything purchased lives in the server ledger. This writes the service flags and
    // nothing else; no quantity, no selection, no order.
    expect(goDone).toContain('onServicesChange(next)')
    expect(goDone).not.toMatch(/setQty\(/)
    expect(goDone).not.toMatch(/purchased/)
    expect(goDone).not.toMatch(/fetch\(/)
  })

  it('informs the organizer, and the toast outlives the navigation', () => {
    expect(goDone).toContain('showToast(')
    expect(goDone).toMatch(/switched off/)
    // ToastProvider wraps the whole (dashboard) layout, so a toast raised here survives the
    // router.push that follows it. If that ever moves, this notice becomes invisible.
    expect(code(read('app/(dashboard)/layout.tsx'))).toContain('<ToastProvider>')
  })

  it('leaves photos alone — there is no persisted "photos on" flag to contradict', () => {
    // mediaOpen is local UI state derived from the pending selection, so an auto-off would be
    // correcting a state that is never stored.
    expect(STEP).toContain('const [mediaOpen, setMediaOpen] = useState<boolean>(initialServiceSelection.media > 0)')
    expect(goDone).not.toContain('mediaOpen')
    expect(goDone).not.toContain('media')
  })

  it('still navigates, whatever it did or did not switch off', () => {
    expect(goDone).toContain('router.push(ROUTES.DASHBOARD_EVENTS)')
  })
})
