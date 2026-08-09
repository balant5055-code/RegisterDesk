// RD-RESULTS-XLSX-01 · OOXML inline-string repair.
//
// PURE (string → string). No DOM, no zip, no I/O — so every shape below is unit-tested
// in Node with no browser and no real .xlsx fixture.
//
// ── Why this exists ────────────────────────────────────────────────────────────
// `read-excel-file@9.1.1` reads an inline-string cell with `getCellInlineStringValue`
// (node_modules/read-excel-file/modules/xml/xlsx.js:30), which accepts exactly ONE
// shape — the first element child of `<c>` must be `<is>`, and its first element child
// must be `<t>`. Anything else returns `undefined`, and parseCellValue.js:37-43 turns
// that into a hard `throw`, failing the WHOLE workbook over a single cell.
//
// Four shapes that ECMA-376 permits therefore crash the import (verified against 9.1.1):
//
//   <c r="E5" t="inlineStr"></c>                       ← value omitted
//   <c r="E5" t="inlineStr"/>                           ← value omitted, self-closed
//   <c r="E5" t="inlineStr"><is/></c>                   ← empty CT_Rst
//   <c r="E5" t="inlineStr"><is><r><t>a</t></r></is></c> ← RICH TEXT (formatted runs)
//
// All four are emitted by Excel, LibreOffice, openpyxl and timing systems. Rich text is
// simply what a cell looks like when part of it is bold.
//
// Upgrading does not fix this. 9.3.5 stops throwing but silently yields an EMPTY cell
// for rich text (modules/xml/xlsx.js:85-103 still only reads `<is><t>`), which is worse
// than a crash: a runner's name would vanish rather than fail loudly. It also swaps
// `@xmldom/xmldom` for three new packages. The library exposes no seam to inject cell
// parsing — its `exports` map blocks deep imports, and both public entries bind their
// own XML layer — so the repair has to happen before the library sees the sheet.
//
// ── What this does ─────────────────────────────────────────────────────────────
// Rewrites ONLY the inline-string cells the library cannot read, into the one shape it
// can, preserving the value per spec. `CT_Rst` (§18.4.8) is either a single `<t>` or a
// sequence of `<r>` runs each holding a `<t>`; the value is the concatenation of those
// run texts. `<rPh>` (phonetic guides, §18.4.6) also contains `<t>` but is NOT part of
// the value, so it is excluded — the same rule the library already applies to shared
// strings.
//
// Cells the library CAN already read are left byte-identical, and a sheet needing no
// repair is returned by reference. A well-formed workbook is therefore untouched, which
// is what keeps this a repair rather than a rewrite.
//
// Text is moved as raw, still-escaped XML — never decoded and re-encoded — so entities
// (&amp; &#8217;) and any character content survive exactly.

/** Whitespace permitted between a tag name and its attributes. */
const WS = new Set([' ', '\t', '\n', '\r'])

interface OpenTag {
  /** Index just past the closing `>`. */
  end:         number
  selfClosing: boolean
  /** The attribute text, without the tag name or the trailing `/`. */
  attrs:       string
}

/**
 * Reads the open tag starting at `start` (which must point at `<`), quote-aware so an
 * attribute value containing `>` — legal in XML — cannot end the tag early.
 */
function readOpenTag(xml: string, start: number, nameLength: number): OpenTag | null {
  let quote: string | null = null
  for (let p = start + 1 + nameLength; p < xml.length; p++) {
    const ch = xml[p]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') {
      const selfClosing = xml[p - 1] === '/'
      return {
        end:   p + 1,
        selfClosing,
        attrs: xml.slice(start + 1 + nameLength, selfClosing ? p - 1 : p),
      }
    }
  }
  return null
}

/** True when this `<c>` carries `t="inlineStr"`. */
function isInlineStringCell(attrs: string): boolean {
  return /\bt\s*=\s*("inlineStr"|'inlineStr')/.test(attrs)
}

/**
 * Name of the first ELEMENT child of a fragment — the same notion of "first element
 * child" the library uses, so this predicate agrees with it. Text, comments, CDATA and
 * processing instructions are skipped.
 */
function firstElementName(fragment: string): string | null {
  let p = 0
  while (p < fragment.length) {
    const lt = fragment.indexOf('<', p)
    if (lt === -1) return null

    const next = fragment[lt + 1]
    if (next === '!' || next === '?') {          // comment / CDATA / PI — skip past it
      const gt = fragment.indexOf('>', lt)
      if (gt === -1) return null
      p = gt + 1
      continue
    }
    if (next === '/') return null                // a closing tag came first: no children

    const name = /^[^\s/>]+/.exec(fragment.slice(lt + 1))
    return name ? name[0] : null
  }
  return null
}

/** Inner content of the first `<name>` element in a fragment, or null. */
function elementInner(fragment: string, name: string): string | null {
  let p = 0
  while (p < fragment.length) {
    const lt = fragment.indexOf(`<${name}`, p)
    if (lt === -1) return null

    const after = fragment[lt + 1 + name.length]
    if (after !== undefined && !WS.has(after) && after !== '>' && after !== '/') {
      p = lt + 1 + name.length                   // a longer name, e.g. <table> for <t>
      continue
    }

    const open = readOpenTag(fragment, lt, name.length)
    if (!open) return null
    if (open.selfClosing) return ''

    const close = fragment.indexOf(`</${name}>`, open.end)
    return close === -1 ? null : fragment.slice(open.end, close)
  }
  return null
}

/**
 * True when `read-excel-file` can already read this cell — its first element child is
 * `<is>` and that element's first element child is `<t>`. Such cells are left alone.
 */
function isReadableShape(cellInner: string): boolean {
  if (firstElementName(cellInner) !== 'is') return false
  const is = elementInner(cellInner, 'is')
  return is !== null && firstElementName(is) === 't'
}

/**
 * The cell's string value: every `<t>` in document order, concatenated, with phonetic
 * runs excluded. Returns raw escaped XML text, ready to be re-emitted verbatim.
 */
export function extractInlineStringText(cellInner: string): string {
  // <rPh> holds a pronunciation guide, not part of the value (§18.4.6). Removing the
  // whole element also removes the <t> inside it.
  const value = cellInner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')

  let text = ''
  let p = 0
  while (p < value.length) {
    const lt = value.indexOf('<t', p)
    if (lt === -1) break

    const after = value[lt + 2]
    if (after !== undefined && !WS.has(after) && after !== '>' && after !== '/') {
      p = lt + 2                                  // <table>, <tr>… not <t>
      continue
    }

    const open = readOpenTag(value, lt, 1)
    if (!open) break
    if (open.selfClosing) { p = open.end; continue }   // <t/> contributes nothing

    const close = value.indexOf('</t>', open.end)
    if (close === -1) break
    text += value.slice(open.end, close)
    p = close + 4
  }
  return text
}

/**
 * Repairs every inline-string cell in a worksheet XML part that `read-excel-file`
 * cannot read. Returns the input by reference when nothing needed repair.
 */
export function normalizeInlineStrings(sheetXml: string): string {
  let out    = ''
  let cursor = 0        // start of the not-yet-copied remainder
  let p      = 0

  while (p < sheetXml.length) {
    const lt = sheetXml.indexOf('<c', p)
    if (lt === -1) break

    // `<c` must be the whole tag name — not `<col>`, `<cols>` or `<cellXfs>`.
    const after = sheetXml[lt + 2]
    if (after === undefined || (!WS.has(after) && after !== '>' && after !== '/')) {
      p = lt + 2
      continue
    }

    const open = readOpenTag(sheetXml, lt, 1)
    if (!open) break
    if (!isInlineStringCell(open.attrs)) { p = open.end; continue }

    // A `<c>` element never nests, so the next `</c>` is unambiguously this cell's.
    let cellInner: string
    let cellEnd:   number
    if (open.selfClosing) {
      cellInner = ''
      cellEnd   = open.end
    } else {
      const close = sheetXml.indexOf('</c>', open.end)
      if (close === -1) break                     // malformed tail — leave it to the library
      cellInner = sheetXml.slice(open.end, close)
      cellEnd   = close + 4
    }

    if (!open.selfClosing && isReadableShape(cellInner)) { p = cellEnd; continue }

    // `xml:space="preserve"` because the extracted value may legitimately begin or end
    // with a space. The library applies its own trimming afterwards, exactly as it does
    // for a cell that was already in this shape — so trimming behaviour is unchanged.
    const openTag = sheetXml.slice(lt, open.end - (open.selfClosing ? 2 : 1)) + '>'
    const text    = extractInlineStringText(cellInner)

    out   += sheetXml.slice(cursor, lt) + openTag
           + `<is><t xml:space="preserve">${text}</t></is></c>`
    cursor = cellEnd
    p      = cellEnd
  }

  if (cursor === 0) return sheetXml               // nothing repaired — same reference
  return out + sheetXml.slice(cursor)
}
