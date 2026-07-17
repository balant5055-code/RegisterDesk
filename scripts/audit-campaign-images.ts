#!/usr/bin/env node
/**
 * scripts/audit-campaign-images.ts
 *
 * TASK 8 — Report (never silently ignore) donationCampaigns documents whose
 * cover image URL is not an approved host (e.g. a pasted Google thumbnail
 * `encrypted-tbn0.gstatic.com`, a googleusercontent mirror, or a malformed URL).
 *
 * READ-ONLY: prints collection / document / field / value for every offender.
 * It writes nothing — remediation is left to the operator (the app already
 * neutralises these at read/render time, so no page can crash).
 *
 * Run:  npx tsx scripts/audit-campaign-images.ts
 * Requires FIREBASE_SERVICE_ACCOUNT_KEY in .env.local (base64 service account).
 */

import fs   from 'node:fs'
import path from 'node:path'

// ── 1. Load .env.local ────────────────────────────────────────────────────────
const envFile = path.resolve(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const val = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!process.env[key]) process.env[key] = val
  }
}

// ── 2. Firebase Admin ─────────────────────────────────────────────────────────
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore }                  from 'firebase-admin/firestore'

;(function initAdmin() {
  if (getApps().length > 0) return
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!encoded) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT_KEY is not set in .env.local')
    process.exit(1)
  }
  const sa = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
  initializeApp({ credential: cert(sa) })
})()

const db = getFirestore()

// ── 3. Validation (mirror of lib/utils/imageUrl.ts — inlined so the script is
//        standalone and does not depend on path-alias resolution) ──────────────
const APPROVED = new Set([
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'res.cloudinary.com',
  'images.unsplash.com',
])

function isValidImageUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return false }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  if (host.endsWith('gstatic.com') || host.endsWith('googleusercontent.com')) return false
  return APPROVED.has(host)
}

// ── 4. Scan ───────────────────────────────────────────────────────────────────
async function main() {
  const snap = await db.collection('donationCampaigns').get()
  const offenders: { doc: string; field: string; value: string }[] = []

  snap.forEach(doc => {
    const data = doc.data() as { campaignDetails?: { media?: { coverImageUrl?: unknown } } }
    const url  = data.campaignDetails?.media?.coverImageUrl
    // Only flag NON-EMPTY invalid values (null/'' is a legitimate "no image").
    if (url != null && url !== '' && !isValidImageUrl(url)) {
      offenders.push({ doc: doc.id, field: 'campaignDetails.media.coverImageUrl', value: String(url) })
    }
  })

  console.log(`\nScanned ${snap.size} document(s) in collection "donationCampaigns".`)
  if (offenders.length === 0) {
    console.log('✓ No invalid cover image URLs found.\n')
    return
  }

  console.log(`\n✗ Found ${offenders.length} document(s) with an unapproved cover image URL:\n`)
  for (const o of offenders) {
    console.log(`  collection: donationCampaigns`)
    console.log(`  document:   ${o.doc}`)
    console.log(`  field:      ${o.field}`)
    console.log(`  value:      ${o.value}`)
    console.log('')
  }
  console.log('These are already rendered safely (placeholder) by the app. To purge them,')
  console.log('set the field to null on each document above.\n')
}

main().catch(err => { console.error(err); process.exit(1) })
