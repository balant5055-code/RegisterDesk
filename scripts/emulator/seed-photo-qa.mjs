// RD-CERT-EMU-01 — emulator-only seed for certificate + attendee-photo QA.
//
// Creates the `photo-qa-marathon-2026` event and a family of three attendees sharing one
// mobile number, then drives the REAL certificate APIs (template create → layout → activate
// → issue) over HTTP so every document is produced by production validation rather than
// hand-written. Nothing here is fabricated that an API could make.
//
// EMULATOR ONLY. It refuses to run unless the Firestore/Auth/Storage emulator hosts are all
// set, so it can never be pointed at a real project.
//
//   Terminal 1:  npm run emu:start
//   Terminal 2:  npm run emu:dev            (must be listening before this script runs)
//   Terminal 3:  npx dotenv -e .env.emulator -- node scripts/emulator/seed-photo-qa.mjs

import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

// ─── Guardrails ──────────────────────────────────────────────────────────────
const AUTH_HOST    = process.env.FIREBASE_AUTH_EMULATOR_HOST
const FS_HOST      = process.env.FIRESTORE_EMULATOR_HOST
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST
if (!AUTH_HOST || !FS_HOST || !STORAGE_HOST) {
  console.error(
    '\nREFUSING TO RUN — this seed is emulator-only.\n' +
    '  FIREBASE_AUTH_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST and\n' +
    '  FIREBASE_STORAGE_EMULATOR_HOST must all be set.\n' +
    '  Run it as:  npx dotenv -e .env.emulator -- node scripts/emulator/seed-photo-qa.mjs\n',
  )
  process.exit(1)
}

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'
const BUCKET     = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${PROJECT_ID}.appspot.com`
const BASE_URL   = process.env.RD_PROFILE_BASE_URL ?? 'http://localhost:3187'

if (!getApps().length) initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET })
const db   = getFirestore()
const auth = getAuth()

// ─── Fixture ─────────────────────────────────────────────────────────────────
const ORG = {
  uid: 'photo-qa-organizer-uid',
  email: 'photo-qa@registerdesk.test',
  password: 'PhotoQaPassw0rd!',
  displayName: 'Photo QA Organizer',
  organizationName: 'Photo QA Sports',
}
const EVENT_ID = 'photo-qa-marathon-2026'      // draftId AND slug — keeps the QA URL obvious
const SLUG     = 'photo-qa-marathon-2026'
const PASS_ID  = 'pass-10k'
const MOBILE   = '9916803664'                  // shared across the whole family

const FAMILY = [
  { key: 'father', name: 'Arun Kumar',   email: 'father@registerdesk.test', bib: '1001' },
  { key: 'child1', name: 'Meera Kumar',  email: 'child1@registerdesk.test', bib: '1002' },
  { key: 'child2', name: 'Vikram Kumar', email: 'child2@registerdesk.test', bib: '1003' },
]

const now = Timestamp.now()

// ─── A real PNG, generated (no binary fixture to commit) ─────────────────────
function makePng(width, height, rgb = [250, 250, 248]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = buf => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td  = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb)))])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const TEMPLATE_W = 1400
const TEMPLATE_H = 990

// ─── Steps ───────────────────────────────────────────────────────────────────

async function seedOrganizer() {
  const props = { uid: ORG.uid, email: ORG.email, emailVerified: true, password: ORG.password, displayName: ORG.displayName }
  try { await auth.createUser(props) } catch { await auth.updateUser(ORG.uid, props) }
  await db.doc(`users/${ORG.uid}`).set({
    uid: ORG.uid, email: ORG.email, name: ORG.displayName,
    organizationName: ORG.organizationName, role: 'organizer',
    createdAt: now, updatedAt: now,
  }, { merge: true })
  console.log(`  organizer      ${ORG.email}`)
}

/** The draft is what the certificate APIs read for ownership + event metadata. */
function draftDoc() {
  return {
    id: EVENT_ID, uid: ORG.uid,
    currentStep: 6, status: 'published', lifecycleStatus: 'published',
    organizerName: ORG.organizationName,
    eventDetails: {
      info: {
        name: 'Photo QA Marathon 2026', type: 'sports', category: 'running',
        location: 'Coimbatore', venue: 'Race Course', city: 'Coimbatore',
        organizerName: ORG.organizationName,
        description: 'Emulator-only event for certificate + attendee-photo QA.',
      },
      schedule: {
        startDate: '2026-06-15', endDate: '2026-06-15',
        startTime: '06:00', endTime: '11:00', timezone: 'Asia/Kolkata',
      },
      seo: { urlSlug: SLUG },
    },
    pricing: { passes: [{ id: PASS_ID, name: '10K Run', price: 0, status: 'active', unlimited: true, quantity: null }] },
    registrationForm: { sections: [], conditionalRules: [], registrationRules: {} },
    accessControl: { type: 'public', confirmationMode: 'auto' },
    totalCapacity: null, capacityPlan: 'unlimited', planType: 'free_event',
    createdAt: now, updatedAt: now,
  }
}

async function seedEvent() {
  await db.doc(`users/${ORG.uid}/eventDrafts/${EVENT_ID}`).set(draftDoc())
  await db.doc(`events/${SLUG}`).set({
    slug: SLUG, uid: ORG.uid, draftId: EVENT_ID,
    ...draftDoc(), lifecycleStatus: 'published',
    createdAt: now, updatedAt: now,
  })
  await db.doc(`registrationCounters/${SLUG}`).set({
    eventSlug: SLUG, totalCount: FAMILY.length,
    passCounts: { [PASS_ID]: FAMILY.length }, revenuePaise: 0, statsVersion: 3,
  })
  console.log(`  event          events/${SLUG} (+ draft ${EVENT_ID})`)
}

async function seedRegistrations() {
  const ids = []
  for (const p of FAMILY) {
    const id = `photoqa-${p.key}`
    await db.doc(`registrations/${id}`).set({
      id, eventSlug: SLUG, eventName: 'Photo QA Marathon 2026',
      organizerUid: ORG.uid, passId: PASS_ID, passName: '10K Run',
      attendee: { name: p.name, email: p.email, phone: MOBILE, formResponses: {} },
      attendeeName: p.name, attendeeEmail: p.email, attendeePhone: MOBILE,
      bibNumber: p.bib, distance: '10K',
      status: 'confirmed', paymentStatus: 'free', amount: 0,
      ticketCode: `RD-PQ-${p.bib}`,
      createdAt: now, updatedAt: now,
    })
    ids.push({ ...p, registrationId: id })
    console.log(`  registration   ${id}  ${p.name.padEnd(14)} bib ${p.bib}  ${p.email}`)
  }
  return ids
}

/**
 * Uploads the template asset to the STORAGE EMULATOR and returns its download URL.
 *
 * The URL carries a `firebaseStorageDownloadTokens` value, exactly as a production Firebase
 * download URL does. storage.rules keeps `certificates/templates/**` owner-only, and its own
 * comment records the contract the server relies on: "The server fetches files via their
 * download token, which works regardless of these read rules." Without the token the
 * emulator answers 403 and the template's dimensions can never be read.
 */
async function uploadTemplateAsset() {
  const objectPath = `certificates/templates/${ORG.uid}/${EVENT_ID}/photo-qa-template.png`
  const bytes = makePng(TEMPLATE_W, TEMPLATE_H)
  const token = crypto.randomUUID()
  await getStorage().bucket(BUCKET).file(objectPath).save(bytes, {
    contentType: 'image/png',
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  })
  const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  console.log(`  template asset ${objectPath} (${bytes.length} bytes)`)
  return { url, bytes, objectPath }
}

/** Real Firebase ID token from the Auth emulator — the APIs verify it normally. */
async function idToken() {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ORG.email, password: ORG.password, returnSecureToken: true }),
    },
  )
  const j = await res.json()
  if (!j.idToken) throw new Error(`Auth emulator sign-in failed: ${JSON.stringify(j)}`)
  return j.idToken
}

async function api(path, method, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

/** The attendee-photo layout: text + the photo element the whole feature exists for. */
function layout() {
  return {
    version: 1,
    canvas: { width: TEMPLATE_W, height: TEMPLATE_H, unit: 'px' },
    elements: [
      { id: 'title', type: 'text', zIndex: 1, x: 0.5, y: 0.14, width: 0.8, align: 'center',
        content: 'Certificate of Participation', fontFamily: 'helvetica', fontSizeFrac: 0.055,
        weight: 'bold', color: '#1A2B4C' },
      { id: 'name', type: 'text', zIndex: 2, x: 0.5, y: 0.34, width: 0.8, align: 'center',
        content: '{{participantName}}', fontFamily: 'helvetica', fontSizeFrac: 0.07,
        weight: 'bold', color: '#0F172A' },
      { id: 'event', type: 'text', zIndex: 3, x: 0.5, y: 0.46, width: 0.8, align: 'center',
        content: 'has completed {{eventName}}', fontFamily: 'helvetica', fontSizeFrac: 0.032,
        weight: 'normal', color: '#334155' },
      { id: 'bib', type: 'text', zIndex: 4, x: 0.5, y: 0.54, width: 0.6, align: 'center',
        content: 'Bib {{bibNumber}}', fontFamily: 'helvetica', fontSizeFrac: 0.03,
        weight: 'normal', color: '#334155' },
      // THE element under test. assetUrl must be absent/empty and fit MUST be 'contain'
      // (both enforced server-side by validateLayout).
      { id: 'photo', type: 'image', zIndex: 5, x: 0.5, y: 0.72, width: 0.18, height: 0.2,
        source: 'attendeePhoto', fit: 'contain', role: 'image' },
    ],
  }
}

async function main() {
  console.log(`\nSeeding certificate/photo QA (project ${PROJECT_ID})`)
  console.log(`  firestore ${FS_HOST}\n  auth      ${AUTH_HOST}\n  storage   ${STORAGE_HOST}\n`)

  await seedOrganizer()
  await seedEvent()
  const regs = await seedRegistrations()
  const asset = await uploadTemplateAsset()

  const token = await idToken()
  console.log('  auth token     obtained from Auth emulator')

  const base = `/api/organizer/events/${EVENT_ID}/certificates`

  const created = await api(`${base}/templates`, 'POST', token, {
    name: 'Photo QA Template',
    templateType: 'png',
    fileUrl: asset.url,
    fileName: 'photo-qa-template.png',
  })
  const templateId = created.template?.templateId ?? created.templateId
  if (!templateId) throw new Error(`No templateId in response: ${JSON.stringify(created).slice(0, 300)}`)
  console.log(`  template       ${templateId} (created via real API — validation passed)`)

  await api(`${base}/templates/${templateId}/layout`, 'PUT', token, layout())
  console.log('  layout         saved (attendeePhoto element accepted by validateLayout)')

  await api(`${base}/templates/${templateId}`, 'PATCH', token, { isActive: true })
  console.log('  template       ACTIVE')

  const certs = []
  for (const r of regs) {
    const out = await api(`${base}/issue`, 'POST', token, { registrationId: r.registrationId })
    const cert = out.certificate ?? out
    certs.push({ ...r, certificateId: cert.certificateId, templateId: cert.templateId })
    console.log(`  certificate    ${cert.certificateId}  ← ${r.registrationId} (${r.name})`)
  }

  console.log('\nSeed complete.')
  console.log(`  Organizer login : ${ORG.email} / ${ORG.password}`)
  console.log(`  Event           : ${BASE_URL}/events/${SLUG}`)
  console.log(`  Template        : ${templateId}`)
  console.log(`  Shared mobile   : ${MOBILE}`)
  console.table(certs.map(c => ({
    name: c.name, bib: c.bib, email: c.email,
    registrationId: c.registrationId, certificateId: c.certificateId,
  })))
  process.exit(0)
}

main().catch(err => { console.error('\nSEED FAILED:', err.message, '\n'); process.exit(1) })
