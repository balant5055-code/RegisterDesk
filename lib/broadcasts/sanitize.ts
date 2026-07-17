// Server-side HTML sanitizer for broadcast email content.
//
// Strategy: allowlist-only. Every tag and attribute not on the list is removed.
// If anything is removed, `stripped` is set to true so the caller can reject
// the request rather than silently mutating organizer content.
//
// Allowed tags: basic email-safe formatting — no script, style, iframe, form,
// object, embed, input, button, svg, meta, link, or any other executable element.
//
// Allowed attributes: only href (with https?:// scheme check) and title on <a>.
// No event handlers (on*), no style, no class, no id — these can carry XSS.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'hr', 'div', 'span',
])

// Per-tag attribute allowlist. Tags not listed here get no attributes at all.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
}

// Only https?:// links are permitted — strips javascript:, data:, vbscript:, etc.
const SAFE_HREF = /^https?:\/\//i

// Matches any HTML tag (opening, closing, self-closing).
// Capture groups: [1] tag name, [2] attribute string (may be undefined)
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*)?\s*\/?>/g

// Matches a single attribute from within the attribute string.
// Handles: name="val", name='val', name=val, name (boolean)
const ATTR_RE = /\s+([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g

function buildSafeAttrs(tagName: string, rawAttrs: string): string {
  const allowed = ALLOWED_ATTRS[tagName]
  if (!allowed) return ''

  let out = ''
  let m: RegExpExecArray | null

  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(rawAttrs)) !== null) {
    const attrName  = m[1].toLowerCase()
    const attrValue = m[2] ?? m[3] ?? m[4] ?? ''

    if (!allowed.has(attrName)) continue
    if (attrName === 'href' && !SAFE_HREF.test(attrValue)) continue

    // Encode double-quotes in the value to prevent attribute injection.
    out += ` ${attrName}="${attrValue.replace(/"/g, '&quot;')}"`
  }

  return out
}

export interface SanitizeResult {
  clean:   string
  stripped: boolean  // true when any content was removed
}

/**
 * Sanitizes HTML to the broadcast email allowlist.
 * Also strips HTML comments (which can hide XSS payloads from naive parsers).
 *
 * Caller MUST check `stripped` and reject the request when true, so organizers
 * receive an explicit error rather than discovering their email was silently altered.
 */
export function sanitizeBroadcastHtml(html: string): SanitizeResult {
  let stripped = false

  // Strip HTML comments first — they can hide: <!-- <script> --> tricks.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, () => { stripped = true; return '' })

  const clean = noComments.replace(TAG_RE, (match, rawTagName: string, rawAttrs: string | undefined) => {
    const tagName   = rawTagName.toLowerCase()
    const isClosing = match.startsWith('</')

    if (!ALLOWED_TAGS.has(tagName)) {
      stripped = true
      return ''
    }

    if (isClosing) return `</${tagName}>`

    const safeAttrs = rawAttrs ? buildSafeAttrs(tagName, rawAttrs) : ''

    // If the original tag had attributes but we stripped them all, flag it.
    if (rawAttrs && rawAttrs.trim() && !safeAttrs) stripped = true

    return `<${tagName}${safeAttrs}>`
  })

  return { clean, stripped }
}
