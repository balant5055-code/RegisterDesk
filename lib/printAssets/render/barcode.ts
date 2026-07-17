// PA barcode encoder (GA-4 S2). Pure, dependency-free (client + server safe).
//
// Produces a 1-D module pattern (true = dark bar, false = light space) for Code128
// and EAN-13, which the render targets draw as filled rectangles — the SAME
// dependency-free approach the QR renderer uses (lib/qr/draw). QR is unchanged.
//
// Standard, published symbologies:
//   • Code128 (Code Set B): ASCII 32..126, start-B + modulo-103 checksum + stop.
//   • EAN-13: 12 data digits + checksum, L/G/R codes with first-digit parity.
// An unencodable value returns an empty module array → the target draws nothing.

export type BarcodeFormat = 'code128' | 'ean13'

// ─── Code128 (Set B) ────────────────────────────────────────────────────────────
// 107 patterns (0..106): six element widths summing to 11, stop (106) is 7 elements.
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
]
const CODE128_START_B = 104
const CODE128_STOP    = 106

/** Expands one Code128 pattern string ("212222") into dark/light modules (bar first). */
function expandPattern(pattern: string, out: boolean[]): void {
  for (let i = 0; i < pattern.length; i++) {
    const w = pattern.charCodeAt(i) - 48   // '0'..'9'
    const dark = i % 2 === 0               // element 0 is a bar
    for (let k = 0; k < w; k++) out.push(dark)
  }
}

function code128Modules(value: string): boolean[] {
  // Set B covers ASCII 32..126; reject anything outside so the code stays scannable.
  const codes: number[] = []
  for (const ch of value) {
    const c = ch.charCodeAt(0)
    if (c < 32 || c > 126) return []
    codes.push(c - 32)
  }
  if (codes.length === 0) return []

  let checksum = CODE128_START_B
  codes.forEach((v, i) => { checksum += v * (i + 1) })
  checksum %= 103

  const symbols = [CODE128_START_B, ...codes, checksum, CODE128_STOP]
  const modules: boolean[] = []
  for (const s of symbols) expandPattern(CODE128_PATTERNS[s], modules)
  return modules
}

// ─── EAN-13 ──────────────────────────────────────────────────────────────────────
const EAN_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011']
const EAN_G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111']
const EAN_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100']
// Parity of the six LEFT digits, selected by the first digit ('L' = odd, 'G' = even).
const EAN_PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL']

function ean13CheckDigit(d12: number[]): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += d12[i] * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

function bitsToModules(bits: string, out: boolean[]): void {
  for (const b of bits) out.push(b === '1')
}

function ean13Modules(value: string): boolean[] {
  const digits = value.replace(/\s/g, '')
  if (!/^\d{12,13}$/.test(digits)) return []
  const nums = digits.split('').map(Number)
  const d12  = nums.slice(0, 12)
  const check = ean13CheckDigit(d12)
  if (nums.length === 13 && nums[12] !== check) return []   // supplied check digit is wrong
  const full = [...d12, check]

  const parity = EAN_PARITY[full[0]]
  const mods: boolean[] = []
  bitsToModules('101', mods)                                   // start guard
  for (let i = 0; i < 6; i++) {
    const digit = full[i + 1]
    bitsToModules(parity[i] === 'L' ? EAN_L[digit] : EAN_G[digit], mods)
  }
  bitsToModules('01010', mods)                                 // centre guard
  for (let i = 0; i < 6; i++) bitsToModules(EAN_R[full[i + 7]], mods)
  bitsToModules('101', mods)                                   // end guard
  return mods
}

/** Returns the dark/light module array for `value` in `format` (empty if invalid). */
export function barcodeModules(value: string, format: BarcodeFormat): boolean[] {
  if (!value) return []
  return format === 'ean13' ? ean13Modules(value) : code128Modules(value)
}

/**
 * Collapses a module array into contiguous DARK runs as [startModule, widthModules]
 * pairs — far fewer rectangles than one per module (matches the QR draw strategy of
 * emitting only dark cells).
 */
export function darkRuns(modules: boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let i = 0
  while (i < modules.length) {
    if (!modules[i]) { i++; continue }
    const start = i
    while (i < modules.length && modules[i]) i++
    runs.push([start, i - start])
  }
  return runs
}
