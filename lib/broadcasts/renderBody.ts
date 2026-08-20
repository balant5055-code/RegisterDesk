// RD-BCAST-FMT-01 · the ONE way a broadcast body becomes email HTML.
//
// Shared by all three surfaces — composer preview, Send Test, real delivery — so they
// cannot drift apart again. Pure and dependency-light on purpose: the preview imports
// this into the browser, so nothing server-only may ever be added here.
//
// This is NOT a rendering engine and must not grow into one. The broadcast composer is
// an HTML editor; the sanitizer at lib/broadcasts/sanitize.ts remains the security
// boundary and the email shell remains the layout. All this adds is the whitespace rule
// that HTML itself does not provide.

import { substituteVariables } from '@/lib/email-templates/types'

// Tags that already create their own vertical break. A newline sitting next to one of
// these is source formatting, not an intended blank line — turning it into a <br> would
// add spacing the author never asked for.
//
// The list is a deliberate superset of the sanitizer's block allowlist: table tags cannot
// survive sanitisation today, but rows stored before that gate existed may still contain
// them, and treating them correctly costs nothing.
const BLOCK_TAGS = 'p|div|ul|ol|li|h2|h3|h1|h4|h5|h6|blockquote|hr|br|table|thead|tbody|tr|td|th'

const ENDS_WITH_BLOCK   = new RegExp(`(?:</(?:${BLOCK_TAGS})>|<(?:br|hr)\\s*/?>)\\s*$`, 'i')
const STARTS_WITH_BLOCK = new RegExp(`^\\s*</?(?:${BLOCK_TAGS})\\b`, 'i')

/**
 * Converts author line breaks into `<br>`, leaving HTML block structure alone.
 *
 * WHY THIS EXISTS. HTML collapses newlines, so a body typed as separate lines arrived as
 * one run-on paragraph. Every line the organizer wrote was being silently joined to the
 * next.
 *
 * WHY IT IS NOT A BLANKET REPLACE. A body already written as `<p>…</p>\n<p>…</p>` would
 * gain a stray `<br>` between the paragraphs and render with a widening gap — a visible
 * change to messages that were composed and approved before this function existed. A
 * newline adjacent to a block tag is therefore preserved as-is (inert whitespace), so
 * such bodies come through byte-identical.
 *
 * SAFETY. The only markup this can introduce is `<br>` — already on the sanitizer's
 * allowlist — and it is applied to the stored, ALREADY-SANITIZED template, never to
 * substituted values. Nothing here can widen what an organizer is allowed to send.
 */
export function newlinesToBreaks(html: string): string {
  const lines = html.replace(/\r\n?/g, '\n').split('\n')

  let out = lines[0] ?? ''
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]
    const next = lines[i]
    // Test the SOURCE line, never the accumulated output. Testing the output meant a <br>
    // this loop had just written counted as a block tag, so the second newline of a blank
    // line was swallowed and `a\n\nb` collapsed to a single break — losing exactly the
    // paragraph spacing the author typed.
    out += ENDS_WITH_BLOCK.test(prev) || STARTS_WITH_BLOCK.test(next) ? '\n' : '<br>'
    out += next
  }
  return out
}

/**
 * Stored broadcast HTML → the body fragment handed to emailShell.
 *
 * ORDER MATTERS, and it is line-breaks BEFORE substitution. Values are HTML-escaped as
 * they are inserted, so running the break conversion first guarantees a newline inside an
 * attendee-supplied value (a pasted multi-line name, say) stays inert whitespace and can
 * never become a tag — not even the harmless one. The template is the only thing whose
 * newlines carry authorial meaning.
 */
export function renderBroadcastBody(storedHtml: string, vars: Record<string, string>): string {
  return substituteVariables(newlinesToBreaks(storedHtml), vars, { escapeValues: true })
}
