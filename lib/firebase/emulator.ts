// RD-EVENT-16 · Firebase Local Emulator Suite wiring.
//
// ═══ FAIL-SAFE OFF ═══════════════════════════════════════════════════════════
// Emulators are used ONLY when `NEXT_PUBLIC_FIREBASE_EMULATOR` is exactly the string
// 'true'. Anything else — unset, empty, '1', 'TRUE' — means production. There is no
// heuristic, no NODE_ENV sniffing, and no "looks like localhost" guess: connecting a
// production build to an emulator, or a test run to production, are both unacceptable, so
// the switch is explicit and boring.
//
// The flag must be `NEXT_PUBLIC_*` because it is read in the browser, and Next.js only
// inlines LITERAL `process.env.NEXT_PUBLIC_X` reads into the client bundle — a dynamic
// lookup evaluates to undefined on the client. `lib/firebase/config.ts` documents the same
// hazard; this file follows that rule deliberately.

/** Default Emulator Suite ports. Kept in sync with the `emulators` block of firebase.json. */
export const EMULATOR_PORTS = {
  auth:      9099,
  firestore: 8080,
  storage:   9199,
  ui:        4000,
} as const

export const EMULATOR_HOST = '127.0.0.1'

/**
 * Whether this process should talk to emulators.
 *
 * Written as a literal comparison so the value is inlined into the client bundle.
 */
export const USE_FIREBASE_EMULATOR = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === 'true'

/**
 * The project id emulators run under.
 *
 * `demo-` prefixed projects are special-cased by the Firebase tooling: they can never reach
 * a real backend, so a misconfigured run fails loudly instead of writing to production.
 */
export const EMULATOR_PROJECT_ID = 'demo-registerdesk'

/** Guards against connecting the same SDK twice under Next's module re-evaluation. */
const connected = new Set<string>()

export function connectOnce(key: string, connect: () => void): void {
  if (!USE_FIREBASE_EMULATOR || connected.has(key)) return
  connected.add(key)
  try {
    connect()
    if (typeof window !== 'undefined') {
      console.info(`[firebase/emulator] ${key} → ${EMULATOR_HOST}:${EMULATOR_PORTS[key as keyof typeof EMULATOR_PORTS]}`)
    }
  } catch (err) {
    // Already-connected errors are benign under hot reload; anything else is worth seeing.
    console.warn(`[firebase/emulator] ${key} connect skipped:`, (err as Error).message)
  }
}
