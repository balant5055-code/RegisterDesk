// Unit verification for the shared phone utility (Phase LS2.2, STEP 10).
// Run: npx tsx scripts/verify-phone.ts   (exits non-zero on any failure)

import { normalizePhoneNumber, validatePhoneNumber, formatPhoneNumber } from '../lib/communication/phone'

let failures = 0

function eq(label: string, got: string, want: string): void {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  →  got "${got}"  want "${want}"`)
}

function assert(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log('── normalizePhoneNumber — India defaults ──')
eq('9363935055',        normalizePhoneNumber('9363935055'),        '919363935055')
eq('+91 93639 35055',   normalizePhoneNumber('+91 93639 35055'),   '919363935055')
eq('91 93639 35055',    normalizePhoneNumber('91 93639 35055'),    '919363935055')
eq('919363935055',      normalizePhoneNumber('919363935055'),      '919363935055')
eq('09363935055',       normalizePhoneNumber('09363935055'),       '919363935055')
eq('(93639) 35-055',    normalizePhoneNumber('(93639) 35-055'),    '919363935055')
eq('+919363935055',     normalizePhoneNumber('+919363935055'),     '919363935055')

console.log('── International — country code preserved, never double-prefixed ──')
eq('UAE 971501234567',  normalizePhoneNumber('971501234567'),      '971501234567')
eq('UAE +971 50 123 4567', normalizePhoneNumber('+971 50 123 4567'), '971501234567')
eq('US 16505551234',    normalizePhoneNumber('16505551234'),       '16505551234')
eq('US +1 650 555 1234', normalizePhoneNumber('+1 650 555 1234'),  '16505551234')

console.log('── Idempotency ──')
eq('normalize(normalize())', normalizePhoneNumber(normalizePhoneNumber('9363935055')), '919363935055')

console.log('── validatePhoneNumber ──')
assert('empty → invalid',            validatePhoneNumber('').valid === false)
assert('valid IN 10-digit',          validatePhoneNumber('9363935055').valid === true)
assert('valid IN normalized',        validatePhoneNumber('9363935055').normalizedPhone === '919363935055')
assert('too short → invalid',        validatePhoneNumber('12345').valid === false)
assert('too long → invalid',         validatePhoneNumber('1234567890123456').valid === false)
assert('letters → invalid',          validatePhoneNumber('93639abc55').valid === false)
assert('UAE valid',                  validatePhoneNumber('971501234567').valid === true)
assert('US valid',                   validatePhoneNumber('16505551234').valid === true)

console.log('── Future-proofing — override default calling code ──')
eq('UK 10-digit w/ code 44', normalizePhoneNumber('7123456789', { defaultCallingCode: '44' }), '447123456789')

console.log('── formatPhoneNumber (display) ──')
eq('format IN', formatPhoneNumber('9363935055'), '+919363935055')

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log('✅ All phone normalization/validation assertions passed')
