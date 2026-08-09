// RD-RACEOPS-01 Sprint 4 · Ordinal formatting.
//
// PURE. Kept out of certificateResults.ts (which imports the Firestore repo) so the
// formatting that ends up on a certificate is unit-testable without booting Firebase.

/** `1` → `1st`, `2` → `2nd`, `11` → `11th`, `21` → `21st`. */
export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:  return `${n}st`
    case 2:  return `${n}nd`
    case 3:  return `${n}rd`
    default: return `${n}th`
  }
}
