/**
 * RD-ANALYTICS-12-21 — the canonical confirmed-revenue STATE.
 *
 * ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 * Confirmed revenue has four states, and for years they were carried by a number plus an
 * optional boolean:
 *
 *   measured value · measured ZERO · could not be read · caller not entitled
 *
 * Nothing in that shape forced a reader to consult the boolean, so "could not be read"
 * degraded into a confident ₹0 whenever someone wrote `?? 0`. That is not hypothetical:
 * RD-ANALYTICS-12-20's audit found it live on the dashboard, where a map holding
 * `number | null` (null = UNMEASURED) was published as `revBySlug.get(slug) ?? 0` — turning
 * an unmeasured event into a measured-looking zero, while the KPI total one field away
 * correctly reported it as unavailable.
 *
 * A union fixes that by construction: `paise` cannot be reached without first narrowing
 * `ok`, so the compiler asks the question the convention merely hoped you would.
 *
 * ═══ WHY IT IS NOT `MaybeMoney` ══════════════════════════════════════════════
 * `MaybeMoney` (lib/finance/gatewayFee) is the same idea and this type deliberately copies
 * its shape — `{ ok: true, ... } | { ok: false, reason }` — so there is one narrowing idiom
 * in the codebase rather than two. It is not reused directly because it cannot express
 * AUTHORIZATION DENIAL: Analytics says that by omitting its whole `financial` block, which
 * is a block-level answer. The Organizer contracts deny per FIELD, inside a payload the
 * caller is otherwise entitled to, so the denial has to live in the value.
 *
 * Extending `Unavailable` with an `unauthorized` member was considered and rejected: that
 * type is consumed across Finance and Analytics, and widening a shared union to serve one
 * caller pushes a breaking change through modules this work is not allowed to touch.
 *
 * ═══ THE ENCODING ON THE WIRE ════════════════════════════════════════════════
 * This type is the SOURCE OF TRUTH. The legacy pair (`revenuePaise` + `revenueUnavailable`)
 * is derived from it by `toLegacyRevenueFields`, never assembled by hand — which is what
 * makes the two fields incapable of contradicting each other.
 */

/**
 * Confirmed ticket revenue in integer paise, or the reason there is no figure.
 *
 *   { ok: true,  paise }                  · measured. `paise: 0` means the event earned nothing.
 *   { ok: false, reason: 'unavailable' }  · the read failed. NOT zero — the amount is unknown.
 *   { ok: false, reason: 'unauthorized' } · the caller lacks `transactions`. NOT zero, and
 *                                           NOT a failure: nothing went wrong.
 */
export type RevenueState =
  | { ok: true;  paise: number }
  | { ok: false; reason: RevenueMissingReason }

/** Why there is no figure. Distinct causes that must never share one presentation. */
export type RevenueMissingReason = 'unavailable' | 'unauthorized'

/** A measured figure. Zero is measured — it is the answer, not the absence of one. */
export const revenueMeasured = (paise: number): RevenueState =>
  ({ ok: true, paise: Math.trunc(paise) })

/** The read failed. The amount is unknown; do not substitute one. */
export const revenueUnmeasured = (): RevenueState =>
  ({ ok: false, reason: 'unavailable' })

/** The caller is not entitled to the figure. Nothing failed. */
export const revenueWithheld = (): RevenueState =>
  ({ ok: false, reason: 'unauthorized' })

/**
 * The dashboard's counter map, resolved to a state — the exact site of the RD-12-20 F1 defect.
 *
 * The map's values are `number | null` where **null means UNMEASURED** (its self-healing
 * aggregate stores `null` on a failed read, precisely so a failure is not mistaken for ₹0).
 * The three inputs are kept distinct:
 *
 *   not entitled          → withheld, regardless of what the map holds (and the caller's
 *                           financial read should not have been issued at all).
 *   no slug               → measured 0. An unpublished event has no counter to read, so its
 *                           zero is real — the same rule the events list applies.
 *   slug present, null    → UNMEASURED. This is the bug being fixed; it used to become 0.
 *   slug absent from map  → measured 0, preserving existing behaviour for an event whose
 *                           counter was never looked up. Called out rather than silently
 *                           folded in with the null case, because the two are not the same
 *                           fact and only one of them was defective.
 */
export function revenueStateFromCounterMap(
  map: ReadonlyMap<string, number | null>,
  slug: string | null,
  financeAllowed: boolean,
): RevenueState {
  if (!financeAllowed) return revenueWithheld()
  if (!slug)           return revenueMeasured(0)
  if (!map.has(slug))  return revenueMeasured(0)
  const v = map.get(slug)
  return v === null || v === undefined ? revenueUnmeasured() : revenueMeasured(v)
}

/**
 * The wire fields, derived from the state.
 *
 * This is the platform's existing encoding — the one `/api/organizer/events` has used since
 * RD-EVENT-02 — so adopting it makes the dashboard consistent rather than novel, and keeps
 * every current consumer compiling:
 *
 *   measured      → the number, flag false
 *   unavailable   → `0` with the flag TRUE. The zero is a placeholder the flag disowns; a
 *                   reader that checks the flag is correct, and one that ignores it is no
 *                   worse off than before this change.
 *   unauthorized  → `null`, flag false. `null` already carries the denial, so the flag stays
 *                   false and keeps meaning only "the platform failed", which it did not.
 *
 * Both fields come from ONE state, so they cannot disagree.
 */
export interface LegacyRevenueFields {
  revenuePaise:       number | null
  revenueUnavailable: boolean
}

export function toLegacyRevenueFields(s: RevenueState): LegacyRevenueFields {
  if (s.ok) return { revenuePaise: s.paise, revenueUnavailable: false }
  return s.reason === 'unauthorized'
    ? { revenuePaise: null, revenueUnavailable: false }
    : { revenuePaise: 0,    revenueUnavailable: true  }
}

/**
 * Is this figure safe to display as a number? The one predicate a UI needs, so that
 * "measured" is asked for by name instead of re-derived from a value and a flag.
 */
export const isRevenueMeasured = (s: RevenueState): s is { ok: true; paise: number } => s.ok

/**
 * RD-ANALYTICS-12-22 · a state from a figure and a failure flag.
 *
 * The dashboard keeps its failure signal INSIDE its map (`null` = unmeasured), which
 * `revenueStateFromCounterMap` reads. The two Organizer event routes carry the same three
 * facts in a different shape — a number, a separate "this read failed" flag, and the
 * permission — because their failure signal is a `Set` of slugs, not a null. This is the
 * constructor for that shape, so both layouts converge on one state type instead of one of
 * them keeping a bespoke ternary.
 *
 * ORDER MATTERS, and it matches what both routes already did: **entitlement outranks
 * failure**. A caller who may not see the figure is `withheld`, never `unavailable` — being
 * refused is not the platform breaking, and telling a manager "we could not read it" would
 * be a lie about a read that was deliberately never issued.
 */
export function revenueStateFrom(
  opts: { financeAllowed: boolean; unavailable: boolean; paise: number },
): RevenueState {
  if (!opts.financeAllowed) return revenueWithheld()
  return opts.unavailable ? revenueUnmeasured() : revenueMeasured(opts.paise)
}

/**
 * The same wire pair under the Organizer event routes' field name.
 *
 * Those routes call the figure `confirmedRevenuePaise`; the dashboard calls it
 * `revenuePaise`. Converging the two NAMES is a rename-class migration with its own phase —
 * so this adapter renames the key and nothing else, **delegating** the actual encoding to
 * `toLegacyRevenueFields` so the legacy pair still has exactly one constructor. If the
 * encoding ever changes, it changes in one place and both contracts follow.
 */
export interface ConfirmedRevenueFields {
  confirmedRevenuePaise: number | null
  revenueUnavailable:    boolean
}

export function toConfirmedRevenueFields(s: RevenueState): ConfirmedRevenueFields {
  const { revenuePaise, revenueUnavailable } = toLegacyRevenueFields(s)
  return { confirmedRevenuePaise: revenuePaise, revenueUnavailable }
}
