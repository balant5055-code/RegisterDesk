// Meta Graph API error normalization (STEP 7).
//
// The Graph API returns errors as { error: { message, type, code, error_subcode,
// fbtrace_id } }. We NEVER surface that raw payload to callers — it can contain
// internal identifiers and verbose text. Instead we map known codes to terse,
// safe messages and classify retriability for a future queue/retry phase.

export interface NormalizedMetaError {
  message:          string    // safe, human-readable — never a raw Meta payload
  code?:            number    // Graph error code, for internal telemetry only
  retriable:        boolean   // classification hint for a future retry phase
  httpStatus?:      number    // HTTP status of the Graph response (LS2.1 diagnostics)
  providerMessage?: string    // raw Meta error message — for server logs/diagnostics only
}

interface GraphErrorBody {
  error?: {
    message?:       string
    type?:          string
    code?:          number
    error_subcode?: number
    fbtrace_id?:    string
  }
}

/** Normalize a non-2xx Graph API response into a safe error (+ diagnostics). */
export function normalizeMetaError(status: number, body: unknown): NormalizedMetaError {
  const err  = (body as GraphErrorBody | null)?.error
  const code = typeof err?.code === 'number' ? err.code : undefined
  const providerMessage = typeof err?.message === 'string' ? err.message : undefined

  const base: NormalizedMetaError = (() => {
    switch (code) {
      case 190:    return { message: 'WhatsApp access token is expired or invalid', code, retriable: false }
      case 100:    return { message: 'Invalid WhatsApp request parameter',          code, retriable: false }
      case 10:
      case 200:
      case 803:    return { message: 'Permission denied for WhatsApp messaging',    code, retriable: false }
      case 131030: return { message: 'Recipient phone number is not in the allowed list (add it under Meta → WhatsApp → API Setup)', code, retriable: false }
      case 4:
      case 80007:
      case 130429: return { message: 'WhatsApp rate limit reached',                 code, retriable: true }
      case 131048: return { message: 'WhatsApp messaging limit reached',            code, retriable: true }
      case 131047: return { message: 'WhatsApp re-engagement required (24h window closed)', code, retriable: false }
      case 132000: return { message: 'WhatsApp template is missing or not approved', code, retriable: false }
      case 1:
      case 2:      return { message: 'WhatsApp API temporarily unavailable',        code, retriable: true }
      default:
        if (status === 401 || status === 403) return { message: 'Meta authentication failed', code, retriable: false }
        if (status === 429)                    return { message: 'Meta rate limit exceeded',    code, retriable: true }
        if (status >= 500)                     return { message: 'Meta API server error',       code, retriable: true }
        return {
          message:   code ? `Meta API error (code ${code})` : `Meta API error (HTTP ${status})`,
          code,
          retriable: false,
        }
    }
  })()

  return { ...base, httpStatus: status, providerMessage }
}

/** Normalize a network/transport failure (timeout, DNS, abort). */
export function normalizeMetaNetworkError(err: unknown): NormalizedMetaError {
  const name = err && typeof err === 'object' && 'name' in err
    ? String((err as { name: unknown }).name)
    : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { message: 'Meta API request timed out', retriable: true }
  }
  return { message: 'Meta API network error', retriable: true }
}
