// RD-GA-HARDEN-01 — lightweight in-memory Firestore mock.
//
// Not a full emulator: it models documents, get/set/update, and a runTransaction that
// does read-then-conditional-write — enough to exercise idempotency patterns (a write
// that no-ops when a deterministic doc id already exists) without real Firebase.
//
// admin.ts initializes the Admin SDK eagerly on import, so any test importing a module
// that transitively imports '@/lib/firebase/admin' must vi.mock it, e.g.:
//   vi.mock('@/lib/firebase/admin', () => ({ adminDb: createMockAdminDb(), adminApp: {}, adminAuth: {} }))

type Data = Record<string, unknown>

export interface MockDocSnapshot {
  exists: boolean
  id: string
  data: () => Data | undefined
}

export function createMockAdminDb() {
  const store = new Map<string, Data>()

  const docRef = (path: string) => ({
    path,
    id: path.split('/').pop() ?? path,
    async get(): Promise<MockDocSnapshot> {
      return { exists: store.has(path), id: path.split('/').pop() ?? path, data: () => store.get(path) }
    },
    async set(d: Data, opts?: { merge?: boolean }) {
      store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...d } : { ...d })
    },
    async update(d: Data) {
      store.set(path, { ...(store.get(path) ?? {}), ...d })
    },
  })

  const collection = (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) })

  type Ref = ReturnType<typeof docRef>
  const tx = {
    async get(ref: Ref) { return ref.get() },
    set(ref: Ref, d: Data, opts?: { merge?: boolean }) { void ref.set(d, opts) },
    update(ref: Ref, d: Data) { void ref.update(d) },
  }

  return {
    collection,
    doc: (path: string) => docRef(path),
    async runTransaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> { return fn(tx) },
    /** Test-only handle to the underlying store. */
    __store: store,
  }
}

export type MockAdminDb = ReturnType<typeof createMockAdminDb>
