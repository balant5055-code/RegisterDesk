// RD-CERT-SCALE P1 · the legacy synchronous event-wide generation route is retired.
//
// WHAT WAS THERE. `app/api/organizer/events/[eventId]/certificates/generate/route.ts` issued
// certificates for a whole event inside ONE request:
//
//   • `.collection('registrations').where(...).get()` — unbounded; 10,000 documents at 10k
//   • a sequential `for` loop, each iteration doing its own read (getCertificateByRegistrationId)
//     and its own write (createCertificateRecord) — 20,000 round trips, one after another
//   • one fire-and-forget email per attendee, with no throttle — 10,000 concurrent sends
//   • no rate limit and no maxDuration, so it timed out mid-loop and left partial state with
//     no cursor, no lease and no way to resume
//
// It was authorized correctly; that was never the problem. The problem is that a single
// authenticated click could saturate Firestore and the mail provider during a live event.
//
// WHY DELETION RATHER THAN A STUB. The audit found ZERO callers — no client fetch, no test,
// no importer of its exported type. A retained stub would keep a live URL whose only purpose
// is to say "don't use me", and the failure it prevents (a stale browser bundle POSTing to
// the old path) fails SAFE either way: 404 and 410 both generate nothing.
//
// THIS SUITE IS THE GUARD. Deleting a file is not a fix if the next person recreates the
// pattern next door, so these tests fail on the SHAPE, not just on the path.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

/** Every source file under the given roots, excluding build output and tests. */
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.next') || name === '.git') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (/\.(ts|tsx)$/.test(name)) out.push(full)
    }
  }
  for (const d of dirs) walk(resolve(root, d))
  return out
}

const APP_SOURCES = sourceFiles(['app', 'components', 'features', 'lib'])

// ─────────────────────────────────────────────────────────────────────────────
describe('the route is gone', () => {
  const ROUTE = 'app/api/organizer/events/[eventId]/certificates/generate/route.ts'

  it('the legacy generate route file does not exist', () => {
    expect(existsSync(resolve(root, ROUTE))).toBe(false)
  })

  it('its directory does not exist either — no index, no re-export', () => {
    expect(existsSync(resolve(root, 'app/api/organizer/events/[eventId]/certificates/generate'))).toBe(false)
  })
})

describe('nothing calls the retired endpoint', () => {
  // The endpoint PATH, not the shared module `@/lib/certificates/generate`, which is
  // legitimate and used by issue / regenerate / preview / personalized.
  const callers = APP_SOURCES.filter(f => {
    const code = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')                  // block comments
      .replace(/^\s*\/\/.*$/gm, '')                      // line comments — history notes
      .replace(/@\/lib\/certificates\/generate/g, '')    // the shared MODULE, legitimate
      .replace(/certificates\/generated/g, '')           // CERT_GENERATED_STORAGE_ROOT
    return /certificates\/generate/.test(code)
  })

  it('no application source references the endpoint path', () => {
    expect(callers.map(f => f.replace(root, ''))).toEqual([])
  })

  it('the certificate hub client offers no generate method', () => {
    const api = read('components/certificates/hub/api.ts')
    expect(api).not.toMatch(/\$\{B\}\/generate/)
  })
})

describe('the two legitimate workflows are intact', () => {
  it('event-wide generation goes through the background job endpoint', () => {
    const bar = read('app/(dashboard)/dashboard/check-in/operations/BulkActionBar.tsx')
    expect(bar).toMatch(/\/api\/organizer\/events\/\$\{eventId\}\/certificates\/jobs/)
    expect(bar).not.toMatch(/\/api\/organizer\/events\/\$\{eventId\}\/certificates\/generate/)
  })

  it('the jobs endpoint still exists and only ENQUEUES — it does not generate inline', () => {
    const jobs = read('app/api/organizer/events/[eventId]/certificates/jobs/route.ts')
    expect(jobs).toMatch(/createJob\(/)
    // Inline generation is what made the legacy route dangerous.
    expect(jobs).not.toMatch(/createCertificateRecord\(/)
    expect(jobs).not.toMatch(/generateCertificate\(/)
  })

  it('single-attendee issuance still exists and reads exactly ONE registration', () => {
    const issue = read('app/api/organizer/events/[eventId]/certificates/issue/route.ts')
    expect(issue).toMatch(/collection\('registrations'\)\s*\.doc\(registrationId\)\.get\(\)/)
    // ...and is bounded by a per-operator rate limit, which the legacy route had none of.
    expect(issue).toMatch(/checkRateLimit\(/)
  })
})

describe('authorization is unchanged everywhere it mattered', () => {
  const CERT_ROUTES = sourceFiles(['app/api/organizer/events'])
    .filter(f => f.includes(`certificates`) && f.endsWith('route.ts'))

  it('every organizer certificate route still authorizes the workspace', () => {
    const unguarded = CERT_ROUTES.filter(f => !/authorizeWorkspace\(/.test(readFileSync(f, 'utf8')))
    expect(unguarded.map(f => f.replace(root, ''))).toEqual([])
  })

  it('there is at least one such route — the check is not vacuously empty', () => {
    expect(CERT_ROUTES.length).toBeGreaterThan(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE GUARD. Deleting one file does not stop the pattern coming back somewhere else,
// so this looks for the combination that made it dangerous: an unbounded read of the
// `registrations` collection in the same request that writes certificate records.

/** Flags source that generates certificates for a whole event synchronously. */
export function detectUnboundedEventWideGeneration(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // An unbounded QUERY: `registrations` + at least one where() + .get(), with no bound.
  // Deliberately NOT `.doc(id).get()` — that is a single-document read, and is exactly what
  // the safe replacements (issue, download) do. A detector that could not tell those apart
  // would flag the fix as the defect.
  const query = /collection\(\s*['"]registrations['"]\s*\)([\s\S]{0,400}?)\.get\(\)/.exec(code)
  if (!query) return false
  const chain = query[1]
  if (!/\.where\(/.test(chain)) return false
  if (/\.limit\(|\.count\(\)|\.doc\(/.test(chain)) return false
  // ...combined with per-attendee certificate creation in the same file.
  return /createCertificateRecord\(|generateCertificate\(/.test(code)
}

describe('the dangerous shape cannot reappear', () => {
  it('no route in the repository generates certificates over an unbounded registration read', () => {
    const offenders = sourceFiles(['app/api'])
      .filter(f => detectUnboundedEventWideGeneration(readFileSync(f, 'utf8')))
    expect(offenders.map(f => f.replace(root, ''))).toEqual([])
  })

  // ── MUTATION TEST ──────────────────────────────────────────────────────────
  // A detector that cannot fire is not a guard. This is the ACTUAL code shape of the
  // deleted route, verbatim in structure, and the detector above must flag it.
  it('MUTATION: restoring the old unbounded read + synchronous loop is detected', () => {
    const restored = `
      export async function POST(req, { params }) {
        const authz = await authorizeWorkspace(req, 'certificates')
        const regsSnap = await adminDb
          .collection('registrations')
          .where('organizerUid', '==', uid)
          .where('eventSlug',    '==', slug)
          .where('status',       '==', 'confirmed')
          .get()
        const regs = regsSnap.docs.map(d => ({ ...d.data(), id: d.id }))
        for (const reg of regs) {
          const existing = await getCertificateByRegistrationId(reg.id)
          if (existing) continue
          await createCertificateRecord({ certificateId: generateCertificateId(), registrationId: reg.id })
        }
      }`
    expect(detectUnboundedEventWideGeneration(restored)).toBe(true)
  })

  it('MUTATION: the detector does NOT fire on the safe replacements', () => {
    // Both of these read registrations too — boundedly. A detector that flagged them would
    // be useless, so this pins the discrimination, not just the alarm.
    expect(detectUnboundedEventWideGeneration(
      read('app/api/organizer/events/[eventId]/certificates/issue/route.ts'))).toBe(false)
    expect(detectUnboundedEventWideGeneration(
      read('app/api/organizer/events/[eventId]/certificates/jobs/route.ts'))).toBe(false)
  })

  it('MUTATION: a bounded (limit) version of the same query is not flagged', () => {
    const bounded = `
      const snap = await adminDb.collection('registrations')
        .where('status', '==', 'confirmed').limit(25).get()
      for (const d of snap.docs) await createCertificateRecord({ registrationId: d.id })`
    expect(detectUnboundedEventWideGeneration(bounded)).toBe(false)
  })
})
