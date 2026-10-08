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
//
// RD-COMMS-P2-C — PARSER-BASED. The previous version matched tags with a regular expression, and
// anything that regex did not recognise as a tag passed through byte-for-byte: `<img/src/onerror=…>`
// (a slash as the attribute separator), `<svg/onload=…>`, `<a/href=javascript:…>`, an unclosed
// trailing `<img src=x onerror=… ` that the surrounding email markup then closed, and so on. Now
// the input is tokenised by a real HTML parser (htmlparser2, via sanitize-html) exactly the way a
// browser/mail client tokenises it, and only allowlisted elements and attributes are re-serialised;
// everything else — including any tag the parser had to repair — is rebuilt from the parse tree,
// never copied through. Attribute values are entity-decoded before the scheme check, so
// `jav&#x61;script:`, `&#106;avascript:` or a tab/newline inside the scheme cannot slip past it.

import sanitizeHtml from 'sanitize-html'

const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'hr', 'div', 'span',
])

// Per-tag attribute allowlist. Tags not listed here get no attributes at all.
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
}

// Only https?:// links are permitted — strips javascript:, data:, vbscript:, relative and
// protocol-relative links, etc. Applied to the DECODED attribute value.
const SAFE_HREF = /^https?:\/\//i

export interface SanitizeResult {
  clean:   string
  stripped: boolean  // true when any content was removed
}

/** The strict pass: the allowlist above, re-serialised from the parse tree. */
const STRICT: sanitizeHtml.IOptions = {
  allowedTags:       [...ALLOWED_TAGS],
  allowedAttributes: ALLOWED_ATTRS,
  allowedSchemes:    ['http', 'https'],
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
  allowedSchemesAppliedToAttributes: ['href'],
  disallowedTagsMode: 'discard',
  // Script/style/etc. bodies are dropped entirely (sanitize-html's default non-text tags).
  transformTags: {
    // Belt and braces over allowedSchemes: an href that is not an absolute http(s) URL after
    // entity decoding (relative, protocol-relative, any other scheme) is removed.
    a: (tagName, attribs) => {
      // Attribute ORDER is preserved, so an untouched link serialises exactly as the input did.
      const kept: Record<string, string> = {}
      for (const [k, v] of Object.entries(attribs)) {
        if (k !== 'href' || SAFE_HREF.test(v)) kept[k] = v
      }
      return { tagName, attribs: kept }
    },
  },
}

/**
 * The SAME parse with nothing removed — the parser-normalised form of the input. When the strict
 * output differs from it, the strict pass removed or changed something.
 */
const PERMISSIVE: sanitizeHtml.IOptions = {
  allowedTags:       false,
  allowedAttributes: false,
  allowVulnerableTags: true,
  allowedSchemes:    ['http', 'https', 'mailto', 'tel', 'data', 'javascript', 'vbscript', 'ftp'],
  allowProtocolRelative: true,
  disallowedTagsMode: 'discard',
  nonTextTags: [],
}

/**
 * Sanitizes HTML to the broadcast email allowlist.
 * Also strips HTML comments (which can hide XSS payloads from naive parsers).
 *
 * Caller MUST check `stripped` and reject the request when true, so organizers
 * receive an explicit error rather than discovering their email was silently altered.
 */
export function sanitizeBroadcastHtml(html: string): SanitizeResult {
  const input = typeof html === 'string' ? html : ''
  const clean = sanitizeHtml(input, STRICT)
  // A comment, a CDATA section or a processing instruction is never kept and always reported.
  const hadHidden = /<!--|<!\[CDATA\[|<\?/i.test(input)
  const stripped = hadHidden || clean !== sanitizeHtml(input, PERMISSIVE)
  return { clean, stripped }
}
