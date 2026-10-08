// RD-EVENT-COMMERCE-05A · rupee ⇄ paise for price INPUTS. PURE, client-safe.
//
// Super Admin types prices in RUPEES ("0.20", "1.90"); everything is STORED and CALCULATED in
// integer PAISE. The conversion is done on the decimal STRING — never `Math.round(rupees * 100)`
// on a float, where e.g. 1.005 * 100 = 100.49999… — so "0.20" is exactly 20 and "1.90" exactly
// 190, and a value can never be multiplied by 100 twice (the stored value is always paise; the
// shown value is always rupees). The server still validates the stored number is a whole,
// positive number of paise, so a value that skipped this parser cannot be stored as 0.2 paise.

export type RupeeParse =
  | { ok: true; paise: number | null }          // null ⇒ the field was left empty ("not set")
  | { ok: false; error: string }

const RUPEES_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/

/** "1.90" → 190, "0.2" → 20, "12" → 1200, "" → null. More than 2 decimals, signs or text → error. */
export function parseRupeesToPaise(raw: string): RupeeParse {
  const s = raw.trim().replace(/^₹\s*/, '').replace(/,/g, '')
  if (s === '') return { ok: true, paise: null }
  const m = RUPEES_RE.exec(s)
  if (!m) {
    return /^\d+\.\d{3,}$/.test(s)
      ? { ok: false, error: 'Use at most 2 decimal places (paise).' }
      : { ok: false, error: 'Enter an amount in rupees, e.g. 0.20 or 1.50.' }
  }
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(paise)) return { ok: false, error: 'That amount is too large.' }
  return { ok: true, paise }
}

/** 20 → "0.20", 190 → "1.90", 150 → "1.50". Non-integer / null → "". */
export function paiseToRupeesInput(paise: number | null | undefined): string {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise) || paise < 0) return ''
  return `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
}
