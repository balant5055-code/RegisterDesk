// Meta Graph API client — server-only.
//
// A thin HTTP wrapper around the Cloud API (no SDK). It encapsulates the base URL,
// API-version pinning, and bearer authentication so that no caller ever sees a raw
// Graph response or the access token. Exposes `get()` (reads: health) and `post()`
// (writes: message send). All non-2xx / transport failures are normalized here.

import { normalizeMetaError, normalizeMetaNetworkError, type NormalizedMetaError } from './errors'
import type { MetaConfig } from './config'

const GRAPH_BASE = 'https://graph.facebook.com'

export type GraphResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: NormalizedMetaError }

// Access-token classification (PART 7). Never contains the token itself.
export interface MetaTokenInfo {
  tokenType:   'system_user' | 'user' | 'page' | 'unknown'
  isPermanent: boolean   // never-expiring (system-user / long-lived) ⇒ production-safe
  isValid:     boolean
  expiresAt:   number     // unix seconds; 0 = never expires
}

export class MetaGraphClient {
  private readonly baseUrl:   string
  private readonly token:     string
  private readonly timeoutMs: number

  constructor(config: MetaConfig) {
    this.baseUrl   = `${GRAPH_BASE}/${config.apiVersion}`
    this.token     = config.accessToken
    this.timeoutMs = config.apiTimeoutMs
  }

  /** GET a Graph node. Auth + version + error normalization handled here. */
  async get<T>(node: string, params?: Record<string, string>): Promise<GraphResult<T>> {
    const url = new URL(`${this.baseUrl}/${node.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
    return this.request<T>('GET', url.toString())
  }

  /** POST a JSON body to a Graph node (e.g. /{PHONE_NUMBER_ID}/messages). */
  async post<T>(node: string, body: unknown): Promise<GraphResult<T>> {
    const url = `${this.baseUrl}/${node.replace(/^\/+/, '')}`
    return this.request<T>('POST', url, body)
  }

  /**
   * Inspect the configured access token via Graph `debug_token` (PART 7). Returns
   * the token's type + whether it never expires — WITHOUT ever exposing the token.
   * Returns null when the check itself fails (e.g. token already invalid).
   */
  async getTokenInfo(): Promise<MetaTokenInfo | null> {
    const res = await this.get<{ data?: { type?: string; is_valid?: boolean; expires_at?: number } }>(
      'debug_token', { input_token: this.token },
    )
    if (!res.ok || !res.data?.data) return null
    const d = res.data.data
    const expiresAt = typeof d.expires_at === 'number' ? d.expires_at : 0
    const raw = (d.type ?? '').toUpperCase()
    const tokenType: MetaTokenInfo['tokenType'] =
      raw === 'SYSTEM_USER' ? 'system_user' : raw === 'USER' ? 'user' : raw === 'PAGE' ? 'page' : 'unknown'
    return {
      tokenType,
      isPermanent: expiresAt === 0 || tokenType === 'system_user',
      isValid:     d.is_valid === true,
      expiresAt,
    }
  }

  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<GraphResult<T>> {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      return { ok: false, error: normalizeMetaNetworkError(err) }
    }

    const json = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: normalizeMetaError(res.status, json) }
    return { ok: true, data: json as T }
  }
}
