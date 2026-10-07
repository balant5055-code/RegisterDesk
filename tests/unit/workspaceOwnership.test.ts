// RD-WORKSPACE-OWNERSHIP-01 — the PURE halves of explicit workspace ownership.
//
// Two things are pure and therefore pinned here; everything that resolves an actual
// caller needs real Firestore and lives in tests/emulator/workspaceOwnership.emu.test.ts:
//
//   • readWorkspaceOwnerMarker — the three-state read. The third state is the whole
//     point: a MISSING marker must not read as "not an owner", or every account that
//     predates the field loses its workspace.
//   • buildOrganizerDeletionManifest — that a deleted organizer's own memberships are
//     swept, and that adding that step did not disturb the ordering the executor's
//     resumability depends on.
//
// Assertions read the RETURNED VALUES, never the source text, so no comment in the
// implementation can satisfy a case here.

import { describe, it, expect } from 'vitest'
import { readWorkspaceOwnerMarker } from '@/lib/organizer/identity'
import { buildOrganizerDeletionManifest } from '@/lib/admin/organizerDeletionManifest'

describe('RD-WORKSPACE-OWNERSHIP-01 · readWorkspaceOwnerMarker is three-state', () => {
  it('reads an explicit true as ownership', () => {
    expect(readWorkspaceOwnerMarker({ workspaceOwner: true })).toBe(true)
  })

  it('reads an explicit false as NON-ownership', () => {
    expect(readWorkspaceOwnerMarker({ workspaceOwner: false })).toBe(false)
  })

  it('reads a MISSING marker as null, not as false', () => {
    // The distinction the whole backward-compatibility story rests on: a legacy document
    // has no marker, and must fall through to the draft inference rather than being
    // demoted. `toBeNull` and not `toBeFalsy` — false would pass a falsy assertion and
    // that is exactly the bug this case exists to catch.
    expect(readWorkspaceOwnerMarker({})).toBeNull()
    expect(readWorkspaceOwnerMarker(null)).toBeNull()
    expect(readWorkspaceOwnerMarker(undefined)).toBeNull()
  })

  it('refuses a non-boolean marker rather than coercing it', () => {
    // A string 'true' or a 1 written by some future path must not silently grant
    // ownership. Anything that is not a boolean is "no answer", i.e. fall back.
    for (const value of ['true', 'false', 1, 0, {}, [], 'yes']) {
      expect(readWorkspaceOwnerMarker({ workspaceOwner: value })).toBeNull()
    }
  })
})

describe('RD-WORKSPACE-OWNERSHIP-01 · organizer deletion sweeps memberships HELD', () => {
  const UID = 'org-under-deletion'
  const manifest = buildOrganizerDeletionManifest(UID)
  const teamSteps = manifest.filter(
    (s): s is Extract<typeof s, { kind: 'query' }> =>
      s.kind === 'query' && s.collection === 'teamMembers',
  )

  it('deletes teamMembers by BOTH organizerUid and memberUid', () => {
    // organizerUid = the members OF this workspace (pre-existing).
    // memberUid    = the grants this person HELD elsewhere (the row that used to survive
    //                deletion and re-attach a restriction to the re-registered account).
    expect(teamSteps.map(s => s.field).sort()).toEqual(['memberUid', 'organizerUid'])
    for (const step of teamSteps) expect(step.value).toBe(UID)
  })

  it('scopes the new sweep so it can only match grants to the deleted uid', () => {
    const held = teamSteps.find(s => s.field === 'memberUid')
    expect(held).toBeDefined()
    // An equality on memberUid; nothing broader. A sweep keyed on anything else (an email,
    // a workspace) could reach a row that grants somebody else access.
    expect(held!.value).toBe(UID)
    expect(held!.collection).toBe('teamMembers')
  })

  it('keeps the irreversible ordering the executor resumes against', () => {
    // The executor replays this manifest by step INDEX, and only the last step is
    // unrecoverable. Inserting a step must not move `users/{uid}` off second-to-last or
    // the Auth deletion off last.
    const last       = manifest[manifest.length - 1]
    const secondLast = manifest[manifest.length - 2]
    expect(last.kind).toBe('auth')
    expect(secondLast).toMatchObject({ kind: 'doc', path: `users/${UID}` })
  })

  it('places the membership sweep BEFORE the profile is deleted', () => {
    // Not cosmetic: a step that runs after `users/{uid}` is gone cannot read anything
    // about the account, and a future sweep that needs the invite email would break there.
    const heldIndex    = manifest.findIndex(s => s.kind === 'query' && s.field === 'memberUid')
    const profileIndex = manifest.findIndex(s => s.kind === 'doc' && s.path === `users/${UID}`)
    expect(heldIndex).toBeGreaterThan(-1)
    expect(heldIndex).toBeLessThan(profileIndex)
  })
})
