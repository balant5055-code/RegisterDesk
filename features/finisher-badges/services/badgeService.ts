// RD-BADGE-01 · Badge generation — SERVER ONLY.
//
// ═══ THE SECURITY INVARIANT ═══════════════════════════════════════════════════
// A badge is built from the OFFICIAL SNAPSHOT and nothing else.
//
// `raceImportSessions` and its draft `results` are not imported by this file, or by anything
// this file imports. A badge therefore CANNOT be produced from an unpublished import — not
// by policy, but because the code has no way to reach one. `getLiveSnapshot` returns only
// `status === 'live'` snapshots, so an unpublished or superseded race yields nothing.
// ══════════════════════════════════════════════════════════════════════════════
//
// Bytes are stored through @/features/platform-storage. This module never names Cloudflare R2.

import { StorageError, sha256Hex, storage } from '@/features/platform-storage'
import {
  fetchByBib, getLiveSnapshot, getLiveSnapshotByPass,
} from '@/features/race-operations/repositories/snapshotRepo'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { renderBadgePng } from '@/features/finisher-badges/render/renderBadge'
import {
  BADGE_MIME, badgeId, type BadgeDoc, type BadgeRenderInput,
} from '@/features/finisher-badges/types'
import { getBadge, recordFailure, recordGenerated, type BadgeScope } from '@/features/finisher-badges/repositories/badgeRepo'
import type { RaceSnapshotDoc } from '@/features/race-operations/types/snapshot'

export type BadgeOutcome<T> =
  | { ok: true;  value: T }
  | { ok: false; status: number; error: string }

/**
 * The event logo, or null.
 *
 * The Official Snapshot does not carry a logo (see the Sprint 7 report, conflict B), so it is
 * read from the PUBLISHED event — public data, already rendered on the public event page.
 * FAIL-SOFT: a missing or unreadable logo yields null and the badge renders without it. A
 * decorative image must never be the reason a participant has no badge.
 */
async function resolveEventLogo(eventSlug: string): Promise<string | null> {
  try {
    const event = await getEventBySlug(eventSlug)
    const media = (event?.eventDetails as Record<string, unknown> | undefined)?.media as
      Record<string, unknown> | undefined
    const logo = media?.logo as { value?: unknown } | undefined
    const url  = typeof logo?.value === 'string' ? logo.value : ''
    // https only — Satori fetches this at render time, so an http or data URL is refused.
    return url.startsWith('https://') ? url : null
  } catch {
    return null
  }
}

/** Assembles the render input from a live snapshot + one entry. */
function toRenderInput(
  snapshot: RaceSnapshotDoc,
  row: { bibNumber: string; name: string | null; chipTimeMs: number | null; status: string; overallRank: number | null },
  eventLogoUrl: string | null,
): BadgeRenderInput {
  return {
    eventName:     snapshot.eventName,
    eventDate:     snapshot.eventDate,
    eventLogoUrl,
    raceName:      snapshot.passName,
    runnerName:    row.name,
    bibNumber:     row.bibNumber,
    chipTime:      row.chipTimeMs !== null ? formatRaceTime(row.chipTimeMs) : null,
    overallRank:   row.overallRank,
    status:        (['finished', 'dnf', 'dns', 'dq'] as const).includes(row.status as never)
      ? row.status as BadgeRenderInput['status']
      : 'finished',
    finisherCount: snapshot.finisherCount,
  }
}

export interface GenerateResult {
  badge:  BadgeDoc
  /** True when the PNG was rendered on this call rather than reused. */
  rendered: boolean
}

/**
 * Ensures a badge exists for one published result.
 *
 * Lazy by default: an existing badge for the CURRENT snapshot version is returned untouched.
 * `force` re-renders — that is what the organizer's Regenerate does.
 *
 * A snapshot bump makes an existing badge stale, and it is re-rendered automatically: the
 * alternative is serving a participant a badge showing a rank that was corrected.
 */
export async function ensureBadge(params: {
  eventSlug: string
  passSlug:  string
  bib:       string
  force?:    boolean
}): Promise<BadgeOutcome<GenerateResult>> {
  const { eventSlug, passSlug, bib, force = false } = params

  // ── The invariant: live snapshots only. An unpublished race resolves to nothing. ──
  const snapshot = await getLiveSnapshot(eventSlug, passSlug)
  if (!snapshot) {
    return { ok: false, status: 404, error: 'No published results for this race.' }
  }

  const key = bibKey(bib)
  const row = await fetchByBib(snapshot.snapshotId, snapshot.version, key)
  if (!row) {
    return { ok: false, status: 404, error: 'No published result for this bib.' }
  }

  const id       = badgeId(eventSlug, snapshot.passId, key)
  const existing = await getBadge(id)

  if (
    !force && existing?.status === 'generated' && existing.path &&
    existing.snapshotVersion === snapshot.version
  ) {
    return { ok: true, value: { badge: existing, rendered: false } }
  }

  const scope: BadgeScope = {
    organizerUid:    snapshot.organizerUid,
    eventId:         snapshot.eventId,
    eventSlug:       snapshot.eventSlug,
    passId:          snapshot.passId,
    passSlug:        snapshot.passSlug,
    bibKey:          key,
    bibNumber:       row.bibNumber,
    snapshotVersion: snapshot.version,
  }

  try {
    const logoUrl = await resolveEventLogo(eventSlug)
    const png = await renderBadgePng(toRenderInput(snapshot, row, logoUrl))

    // Stored through the platform layer, which owns the key, the allow-list and the size
    // ceiling. `event-finisher-badge` already existed there and defaults to PUBLIC.
    const uploaded = await storage.upload({
      type:       'event-finisher-badge',
      eventSlug,
      body:       png,
      mimeType:   BADGE_MIME,
      uploadedBy: snapshot.publishedBy,
      eventId:    snapshot.eventId,
      // Deterministic object id, so a regenerate overwrites rather than orphaning the old
      // PNG — otherwise every regenerate would leak a file nobody can find.
      id:         `${key}.png`,
      tags:       { race: snapshot.passSlug, bib: row.bibNumber },
    })

    const badge = await recordGenerated({
      ...scope,
      path:       uploaded.metadata.path,
      size:       uploaded.metadata.size,
      checksum:   uploaded.metadata.checksum || sha256Hex(png),
      visibility: uploaded.metadata.visibility === 'PRIVATE' ? 'SIGNED_URL' : uploaded.metadata.visibility,
    })

    return { ok: true, value: { badge, rendered: true } }
  } catch (err) {
    const message = err instanceof StorageError
      ? err.message
      : 'The badge could not be generated. Please try again.'

    await recordFailure(scope, message).catch(() => null)

    const status = err instanceof StorageError && err.code === 'NOT_CONFIGURED' ? 503 : 500
    return { ok: false, status, error: message }
  }
}

/** A viewable URL for a stored badge, honouring its visibility. Null when unresolvable. */
export async function resolveBadgeUrl(badge: BadgeDoc): Promise<string | null> {
  if (!badge.path) return null
  try {
    return await storage.resolveUrl({ path: badge.path, visibility: badge.visibility })
  } catch {
    return null
  }
}

/** Downloads the stored PNG bytes — used by the participant download route. */
export async function readBadgeBytes(badge: BadgeDoc): Promise<Uint8Array | null> {
  if (!badge.path) return null
  try {
    const out = await storage.download(badge.path)
    return out.body
  } catch {
    return null
  }
}

/**
 * Resolves a race by passId rather than passSlug — the organizer side knows the pass, the
 * public side knows the slug.
 */
export async function getRaceSnapshotByPass(
  eventSlug: string, passId: string,
): Promise<RaceSnapshotDoc | null> {
  return getLiveSnapshotByPass(eventSlug, passId)
}
