// POST /api/auth/social-profile
// Organizer visibility · create the organizer profile for a SOCIAL sign-in (Google,
// Microsoft, Facebook) at the moment it authenticates, instead of on its first dashboard
// visit. Until now a social signup that never reached the dashboard (e.g. it stopped at
// email verification) had no users/{uid} document, so the admin console could not see it.
//
// It adds no new profile shape: creation is the existing idempotent seam
// (ensureOrganizerProfile), which writes the same document the dashboard heal would —
// role organizer, accountStatus active/pending from the Auth emailVerified flag, no
// organization details, no onboarding. Called best-effort by the login page; a failure
// leaves the dashboard heal as the safety net.
//
// It creates NOTHING (and says why) when:
//   • the Auth record has no linked social provider       → not_social
//   • the account is a gate-staff credential               → staff
//   • users/{uid} already exists (never overwritten)       → exists
//   • the uid is linked to a team membership               → team_member
//     (that account resolves into another organizer's workspace; an own organizer
//     profile is not this route's call to make)

import { NextResponse }       from 'next/server'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import { ensureOrganizerProfile } from '@/lib/organizer/ensureProfile'
import { isStaffEmail, STAFF_COLLECTION } from '@/lib/staff/types'
import { TEAM_COLLECTION } from '@/lib/team/types'
import type { DecodedIdToken } from 'firebase-admin/auth'
import type { UserRecord } from 'firebase-admin/auth'

const SOCIAL_PROVIDER_IDS = new Set(['google.com', 'microsoft.com', 'facebook.com'])

export type SocialProfileReason = 'created' | 'not_social' | 'staff' | 'exists' | 'team_member' | 'failed'

export async function POST(req: Request): Promise<NextResponse> {
  const bearer = req.headers.get('authorization')?.slice(7)
  if (!bearer) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let decoded: DecodedIdToken
  try {
    decoded = await adminAuth.verifyIdToken(bearer, true)
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const uid = decoded.uid

  const done = (reason: SocialProfileReason) =>
    NextResponse.json({ created: reason === 'created', reason }, { status: reason === 'failed' ? 500 : 200 })

  let authUser: UserRecord
  try {
    authUser = await adminAuth.getUser(uid)
  } catch {
    return done('failed')
  }
  // the linked providers, not the token's sign_in_provider: a social credential linked
  // onto an existing password account still counts
  if (!authUser.providerData.some(p => SOCIAL_PROVIDER_IDS.has(p.providerId))) return done('not_social')
  if (isStaffEmail(authUser.email) || isStaffEmail(decoded.email)) return done('staff')

  try {
    const [userSnap, staffSnap, teamSnap] = await Promise.all([
      adminDb.collection('users').doc(uid).get(),
      adminDb.collection(STAFF_COLLECTION).doc(uid).get(),
      adminDb.collection(TEAM_COLLECTION).where('memberUid', '==', uid).limit(1).get(),
    ])
    if (userSnap.exists)  return done('exists')
    if (staffSnap.exists) return done('staff')
    if (!teamSnap.empty)  return done('team_member')

    const profile = await ensureOrganizerProfile(uid)
    return done(profile ? 'created' : 'failed')
  } catch (err) {
    console.error('[social-profile] failed:', err)
    return done('failed')
  }
}
