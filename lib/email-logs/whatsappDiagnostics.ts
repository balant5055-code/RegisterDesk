// RD-WA-LOGS-01 · Organizer-safe WhatsApp diagnostics.
//
// The WhatsApp Logs page shows the organizer WHY Meta rejected a message — the difference
// between "Failed" and "code 132001, the template has no `en` translation" is the difference
// between a support ticket and a self-service fix.
//
// ═══ WHY A SANITISER EXISTS AT ALL ═══════════════════════════════════════════
// `providerResponse` is composed today from httpStatus + Graph error code + Meta's own
// error message, and no credential passes through that path. But it is a free-text field
// written by four different senders, and this module is what puts it in front of a user.
// A future sender that folds a request header or a token into that string must not turn
// this page into a credential leak, so the string is filtered HERE, at the boundary that
// serves it, rather than trusted because of how it happens to be built upstream.

/** Patterns that must never reach a browser, whatever produced them. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,          // Authorization header value
  /\baccess[_-]?token["'\s:=]+[^\s,"']+/gi,
  /\bapp[_-]?secret["'\s:=]+[^\s,"']+/gi,
  /\b(client|api|webhook)[_-]?(secret|key|token)["'\s:=]+[^\s,"']+/gi,
  /\bEAA[A-Za-z0-9]{20,}/g,               // Meta long-lived token prefix
  /\bauthorization["'\s:=]+[^\s,"']+/gi,
]

/** Hard ceiling — a diagnostic is a sentence, not a payload dump. */
const MAX_DIAGNOSTIC_CHARS = 300

/**
 * Strip anything credential-shaped and clamp the length.
 *
 * Redacts rather than dropping the whole string: a partially-redacted diagnostic still
 * tells the organizer the error code, and silently returning nothing would look like the
 * system had no explanation to offer.
 */
export function sanitizeProviderResponse(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let out = raw
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]')
  out = out.trim()
  if (!out) return undefined
  return out.length > MAX_DIAGNOSTIC_CHARS ? `${out.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : out
}

export interface ParsedProviderDiagnostics {
  /** Meta Graph error code, e.g. 132001. */
  code:       number | null
  /** HTTP status of the Graph response, e.g. 404. */
  httpStatus: number | null
}

/**
 * Pull the structured bits out of the stored diagnostic string.
 *
 * Every WhatsApp sender writes the same shape —
 *   `HTTP {status} · code {code} · {meta message}`
 * — so both values are recoverable without a schema change. Missing/`-` placeholders
 * yield null rather than a misleading 0.
 */
export function parseProviderDiagnostics(raw: string | undefined): ParsedProviderDiagnostics {
  if (!raw) return { code: null, httpStatus: null }
  const codeMatch = raw.match(/\bcode\s+(\d+)/i)
  const httpMatch = raw.match(/\bHTTP\s+(\d{3})\b/i)
  return {
    code:       codeMatch ? Number(codeMatch[1]) : null,
    httpStatus: httpMatch ? Number(httpMatch[1]) : null,
  }
}
