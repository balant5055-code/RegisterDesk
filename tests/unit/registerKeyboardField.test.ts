// RD-REGISTER-MOBILE-CTA — which elements may hide the mobile checkout bar.
//
// The bar hides on focus so the on-screen keyboard does not cover the field being typed
// into. The predicate driving that was `tagName === 'INPUT'`, which is TRUE for a
// checkbox — so tapping "Medical Consent" or "Sports Waiver" hid the payment CTA with no
// keyboard to justify it, and it stayed hidden until focus moved. Attendees could not pay.
//
// The predicate lives in RegisterClient (a large client component that cannot be imported
// in the node environment), so the rule is reproduced here verbatim and pinned. It is four
// lines; the risk of drift is far smaller than the risk of shipping this bug again.

import { describe, it, expect } from 'vitest'

const NON_KEYBOARD_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden',
])

/** Mirrors isKeyboardField() in app/events/[slug]/register/RegisterClient.tsx */
function isKeyboardField(el: { tag: 'input' | 'textarea' | 'other'; type?: string } | null): boolean {
  if (!el) return false
  if (el.tag === 'textarea') return true
  if (el.tag === 'input') return !NON_KEYBOARD_INPUT_TYPES.has((el.type ?? 'text').toLowerCase())
  return false
}

describe('consent toggles must NOT hide the payment CTA', () => {
  it.each(['checkbox', 'radio'])('a focused %s is not a keyboard field', t => {
    // The exact regression: Medical Consent and Sports Waiver are checkboxes.
    expect(isKeyboardField({ tag: 'input', type: t })).toBe(false)
  })

  it.each(['button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'])(
    'a focused %s input is not a keyboard field', t => {
      expect(isKeyboardField({ tag: 'input', type: t })).toBe(false)
    },
  )

  it('is case-insensitive on the type attribute', () => {
    expect(isKeyboardField({ tag: 'input', type: 'CHECKBOX' })).toBe(false)
  })

  it('a non-input element never qualifies', () => {
    expect(isKeyboardField({ tag: 'other' })).toBe(false)
    expect(isKeyboardField(null)).toBe(false)
  })
})

describe('genuine keyboard fields still hide the bar — behaviour preserved', () => {
  it.each(['text', 'email', 'tel', 'number', 'password', 'url', 'search', 'date', 'time'])(
    'a focused %s input IS a keyboard field', t => {
      expect(isKeyboardField({ tag: 'input', type: t })).toBe(true)
    },
  )

  it('a textarea is a keyboard field', () => {
    expect(isKeyboardField({ tag: 'textarea' })).toBe(true)
  })

  it('an input with no explicit type defaults to text', () => {
    expect(isKeyboardField({ tag: 'input' })).toBe(true)
  })
})
