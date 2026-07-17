// POST /api/dev/reset — DEVELOPMENT-ONLY database reset. NEVER runs in production.
//
// Recursively deletes EVERY Firestore collection and subcollection. Root collections
// are enumerated with listCollections(); the `users` collection is enumerated with
// listDocuments() — NOT .get() — so it also catches "non-existent parent" documents
// that still hold subcollections (orphaned users/{uid}/eventDrafts, campaignDrafts,
// notifications, …). A collection .get() query returns only documents that EXIST, so
// it structurally skips those orphans — which is exactly what a reset must clean up.
//
// Preserves ONLY the admin account documents (ADMIN_UIDS ∪ the caller) and never
// touches Firebase Auth — auth users are left completely unchanged.
//
// Four independent guards, ALL required:
//   1. Not production            → NODE_ENV !== 'production' && VERCEL_ENV !== 'production' (else 404)
//   2. Explicit opt-in           → ALLOW_DEV_RESET === 'true'                              (else 403)
//   3. Admin caller              → resolveAdminUid()                                        (else 403)
//   4. Explicit confirmation     → body { confirm: 'RESET' }                                (else 400)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
}

function adminUidSet(): Set<string> {
  return new Set((process.env.ADMIN_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean))
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Guard 1 — in production this endpoint does not exist.
  if (isProduction()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Guard 2 — must be explicitly enabled, even in a development environment.
  if (process.env.ALLOW_DEV_RESET !== 'true') {
    return NextResponse.json(
      { error: 'Dev reset is disabled. Set ALLOW_DEV_RESET=true in a development environment to enable it.' },
      { status: 403 },
    )
  }

  // Guard 3 — admin only.
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Guard 4 — explicit confirmation token.
  let body: { confirm?: unknown }
  try { body = await req.json() as { confirm?: unknown } } catch { body = {} }
  if (body.confirm !== 'RESET') {
    return NextResponse.json({ error: 'Confirmation required: POST { "confirm": "RESET" }.' }, { status: 400 })
  }

  // Preserve the admin account docs; never delete the account running the reset.
  const preserve = adminUidSet()
  preserve.add(adminUid)

  // One shared BulkWriter drives every recursiveDelete so we can COUNT real deletes
  // and detect failures (so we never report success while data survives).
  const bulkWriter = adminDb.bulkWriter()
  let documentsDeleted = 0
  let writeFailures    = 0
  bulkWriter.onWriteResult(() => { documentsDeleted++ })
  bulkWriter.onWriteError(err => {
    if (err.failedAttempts < 5) return true      // retry transient failures
    writeFailures++                              // give up on this op, but remember it
    return false
  })

  const collectionsDeleted:  string[]    = []
  const subcollectionNames:  Set<string> = new Set()
  let subcollectionsDeleted = 0
  let preservedUsers        = 0
  let closed                = false

  try {
    const roots = await adminDb.listCollections()   // ROOT collections only (not nested)
    for (const col of roots) {
      if (col.id === 'users') {
        // listDocuments() returns refs for ALL doc IDs — including non-existent
        // parents that still have subcollections (the orphans .get() would miss).
        const userRefs = await col.listDocuments()
        for (const userRef of userRefs) {
          const subs = await userRef.listCollections()
          subcollectionsDeleted += subs.length
          subs.forEach(s => subcollectionNames.add(s.id))
          if (preserve.has(userRef.id)) {
            // Keep the admin account doc, but wipe every subcollection under it.
            for (const sub of subs) await adminDb.recursiveDelete(sub, bulkWriter)
            preservedUsers++
          } else {
            // Delete the user doc AND all of its subcollections.
            await adminDb.recursiveDelete(userRef, bulkWriter)
          }
        }
        collectionsDeleted.push(
          `users (preserved ${preservedUsers} admin doc(s); wiped ${subcollectionsDeleted} subcollection(s): ${[...subcollectionNames].join(', ') || 'none'})`,
        )
      } else {
        await adminDb.recursiveDelete(col, bulkWriter)
        collectionsDeleted.push(col.id)
      }
    }

    // Flush + surface any deletion failure — closing awaits all pending writes.
    await bulkWriter.close()
    closed = true
  } catch (e) {
    if (!closed) { try { await bulkWriter.close() } catch { /* already failing */ } }
    console.error('[dev/reset] failed', e)
    return NextResponse.json(
      { error: 'Reset failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  // Never report success if any delete ultimately failed after retries.
  if (writeFailures > 0) {
    return NextResponse.json(
      { error: `Reset incomplete: ${writeFailures} delete(s) failed after retries. Re-run.`, documentsDeleted },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    message: 'Development database reset complete. Firebase Auth users were NOT modified.',
    summary: {
      collectionsDeleted:    collectionsDeleted.length,
      collections:           collectionsDeleted,
      documentsDeleted,
      subcollectionsDeleted,
      subcollections:        [...subcollectionNames],
      preservedDocuments:    preservedUsers,
    },
  })
}
