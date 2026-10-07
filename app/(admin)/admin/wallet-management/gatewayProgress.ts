// W2.d G2 — manual, bounded continuation of the gateway evidence check. Pure (no React, no fetch),
// so the Wallet Management console and its unit tests share one definition of "where next".
//
// A request covers one batch of one reconciliation page's flagged orders. The next request either
// continues inside the same page (`gatewayAfter`) or, once the page's candidates are all handled,
// moves to the next reconciliation page (its `nextCursor`). Nothing here ever continues on its own:
// every step is an explicit "Check next".

import type { GatewayPageReport } from '@/lib/admin/walletManagementService'
import type { GatewayFinding } from '@/lib/reconciliation/walletTopupsGateway'

/** Where a gateway request starts: the reconciliation page (its S2 cursor) and the position inside it. */
export interface GatewayPosition { cursor: string | null; after: string | null }

export const GATEWAY_START: GatewayPosition = { cursor: null, after: null }

export interface GatewayProgress {
  /** The latest response — enabled / source / circuit state. */
  last:     GatewayPageReport
  /** Accumulated across requests, de-duplicated by order id + finding code. */
  findings: GatewayFinding[]
  /** Flagged orders checked so far (requests never overlap, so the sum counts each order once). */
  checked:  number
  /** Flagged orders whose top-up record no longer exists. */
  missing:  number
  /**
   * F3 — flagged orders that could NOT be checked (unusable order id). Counted from the de-duplicated
   * findings, so a page reported twice (a retry from its start) never counts them twice.
   */
  unverifiable: number
  /** Where "Check next" continues; null = nothing left to check in the records scanned (or disabled). */
  next:     GatewayPosition | null
}

export function gatewayRequestParams(pos: GatewayPosition): Record<string, string | null> {
  return { view: 'reconciliation', kind: 'topups', gateway: '1', cursor: pos.cursor, gatewayAfter: pos.after }
}

/** The position after `report`, the answer to a request made at `pos`. */
export function nextGatewayPosition(pos: GatewayPosition, report: GatewayPageReport, pageNextCursor: string | null): GatewayPosition | null {
  if (!report.enabled) return null                                          // disabled: nothing to continue
  if (!report.pageComplete) return { cursor: pos.cursor, after: report.nextAfter }   // same page, first unchecked order
  return pageNextCursor ? { cursor: pageNextCursor, after: null } : null
}

const findingKey = (f: GatewayFinding) => `${f.orderId}\u0000${f.code}`

/**
 * Fold one response into the progress. `prev` null = a fresh check. Findings already shown for an
 * order + code are not repeated; several findings of one code for one order in the SAME response
 * (e.g. two mismatched payments) are distinct evidence and are all kept.
 */
export function mergeGatewayProgress(
  prev: GatewayProgress | null, pos: GatewayPosition, report: GatewayPageReport, pageNextCursor: string | null,
): GatewayProgress {
  const shown = new Set((prev?.findings ?? []).map(findingKey))
  const findings = [...(prev?.findings ?? []), ...report.findings.filter(f => !shown.has(findingKey(f)))]
  return {
    last:     report,
    findings,
    checked:  (prev?.checked ?? 0) + report.checked,
    missing:  (prev?.missing ?? 0) + report.missing,
    unverifiable: findings.filter(f => f.code === 'gateway_order_id_unverifiable').length,
    next:     nextGatewayPosition(pos, report, pageNextCursor),
  }
}

/** Progress for people. Never "verified", "all verified" or "clean": only what was checked. */
export function gatewayProgressText(p: GatewayProgress): string {
  const parts = [`Flagged orders checked so far: ${p.checked.toLocaleString('en-IN')}`]
  if (p.missing > 0) parts.push(`${p.missing.toLocaleString('en-IN')} no longer on record`)
  if (p.unverifiable > 0) parts.push(`${p.unverifiable.toLocaleString('en-IN')} could not be checked (unusable order id)`)
  if (p.last.circuitOpen) parts.push('stopped after repeated failures — Check next retries from the first unchecked order')
  else parts.push(p.next ? 'more flagged orders to check' : 'no flagged orders left to check in the records scanned')
  return parts.join(' · ')
}
