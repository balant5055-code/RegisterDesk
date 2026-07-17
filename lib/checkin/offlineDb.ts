// Offline check-in storage — IndexedDB only (no localStorage).
//
// Three object stores in one DB:
//   • attendees      — the cached attendee list for the CURRENTLY selected event,
//                      keyed by ticketCode for O(1) scan lookup.
//   • checkInSyncQueue — queued offline check-in actions awaiting replay.
//   • meta           — small key/value records (the current event slug).
//
// Security model: the cache only ever holds ONE event. Selecting a different
// event wipes both the attendee cache and the queue (see setCurrentEvent).

export interface CachedAttendee {
  registrationId: string
  ticketCode:     string
  attendeeName:   string
  passName:       string
  eventSlug:      string
  status:         string
  paymentStatus:  string
  checkedIn:      boolean
  checkedInAt:    string | null
}

export type QueueStatus = 'pending' | 'synced' | 'conflict' | 'failed'

export interface QueueItem {
  id?:            number          // auto-increment key
  ticketCode:     string
  registrationId: string
  attendeeName:   string
  eventSlug:      string
  scannedAt:      string          // ISO, when the operator scanned offline
  source:         string
  status:         QueueStatus
  message?:       string          // conflict / failure detail
}

const DB_NAME  = 'rd-checkin'
const DB_VER   = 2   // v2: adds the QUEUE `ticketCode` index for O(1) queued lookups
const ATTENDEES = 'attendees'
const QUEUE     = 'checkInSyncQueue'
const META      = 'meta'
const META_EVENT_KEY = 'currentEvent'

function hasIDB(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(ATTENDEES)) {
        const s = db.createObjectStore(ATTENDEES, { keyPath: 'ticketCode' })
        s.createIndex('eventSlug', 'eventSlug', { unique: false })
      }
      // Queue store: create on first install, otherwise reuse the existing store
      // from the version-change transaction so missing indexes can be added.
      let q: IDBObjectStore
      if (!db.objectStoreNames.contains(QUEUE)) {
        q = db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true })
        q.createIndex('status', 'status', { unique: false })
        q.createIndex('eventSlug', 'eventSlug', { unique: false })
      } else {
        q = req.transaction!.objectStore(QUEUE)
      }
      // v2: index queued lookups by ticketCode (O(1) instead of full-scan).
      if (!q.indexNames.contains('ticketCode')) {
        q.createIndex('ticketCode', 'ticketCode', { unique: false })
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const r = fn(t.objectStore(store))
    r.onsuccess = () => resolve(r.result)
    r.onerror   = () => reject(r.error)
  })
}

function clearStore(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const r = t.objectStore(store).clear()
    r.onsuccess = () => resolve()
    r.onerror   = () => reject(r.error)
  })
}

// ─── Event selection (security: one event at a time) ─────────────────────────

export async function getCurrentEvent(): Promise<string | null> {
  if (!hasIDB()) return null
  const db = await openDb()
  try {
    const rec = await tx<{ key: string; value: string } | undefined>(db, META, 'readonly', s => s.get(META_EVENT_KEY))
    return rec?.value ?? null
  } finally { db.close() }
}

/**
 * Selects the active event. If it differs from what's cached, wipes the
 * attendee cache AND the sync queue so no other event's data ever lingers.
 * Returns true if a wipe occurred.
 */
export async function setCurrentEvent(eventSlug: string): Promise<boolean> {
  if (!hasIDB()) return false
  const db = await openDb()
  try {
    const rec = await tx<{ key: string; value: string } | undefined>(db, META, 'readonly', s => s.get(META_EVENT_KEY))
    const changed = rec?.value !== eventSlug
    if (changed) {
      await clearStore(db, ATTENDEES)
      await clearStore(db, QUEUE)
    }
    await tx(db, META, 'readwrite', s => s.put({ key: META_EVENT_KEY, value: eventSlug }))
    return changed
  } finally { db.close() }
}

export async function clearAll(): Promise<void> {
  if (!hasIDB()) return
  const db = await openDb()
  try {
    await clearStore(db, ATTENDEES)
    await clearStore(db, QUEUE)
    await clearStore(db, META)
  } finally { db.close() }
}

// ─── Attendee cache ──────────────────────────────────────────────────────────

export async function replaceAttendees(eventSlug: string, attendees: CachedAttendee[]): Promise<void> {
  if (!hasIDB()) return
  const db = await openDb()
  try {
    await clearStore(db, ATTENDEES)
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(ATTENDEES, 'readwrite')
      const s = t.objectStore(ATTENDEES)
      for (const a of attendees) if (a.ticketCode) s.put({ ...a, eventSlug })
      t.oncomplete = () => resolve()
      t.onerror    = () => reject(t.error)
    })
  } finally { db.close() }
}

export async function getAttendee(ticketCode: string): Promise<CachedAttendee | null> {
  if (!hasIDB()) return null
  const db = await openDb()
  try {
    const rec = await tx<CachedAttendee | undefined>(db, ATTENDEES, 'readonly', s => s.get(ticketCode))
    return rec ?? null
  } finally { db.close() }
}

export async function markLocalCheckedIn(ticketCode: string, atISO: string): Promise<void> {
  if (!hasIDB()) return
  const db = await openDb()
  try {
    const rec = await tx<CachedAttendee | undefined>(db, ATTENDEES, 'readonly', s => s.get(ticketCode))
    if (rec) await tx(db, ATTENDEES, 'readwrite', s => s.put({ ...rec, checkedIn: true, checkedInAt: atISO }))
  } finally { db.close() }
}

export async function countAttendees(): Promise<number> {
  if (!hasIDB()) return 0
  const db = await openDb()
  try { return await tx<number>(db, ATTENDEES, 'readonly', s => s.count()) }
  finally { db.close() }
}

// ─── Sync queue ──────────────────────────────────────────────────────────────

export async function enqueue(item: Omit<QueueItem, 'id'>): Promise<number> {
  if (!hasIDB()) return -1
  const db = await openDb()
  try { return await tx<number>(db, QUEUE, 'readwrite', s => s.add(item) as IDBRequest<number>) }
  finally { db.close() }
}

export async function getQueue(): Promise<QueueItem[]> {
  if (!hasIDB()) return []
  const db = await openDb()
  try { return await tx<QueueItem[]>(db, QUEUE, 'readonly', s => s.getAll() as IDBRequest<QueueItem[]>) }
  finally { db.close() }
}

/** Queue items in a given status, fetched via the `status` index (no full scan). */
export async function getQueueByStatus(status: QueueStatus): Promise<QueueItem[]> {
  if (!hasIDB()) return []
  const db = await openDb()
  try {
    return await tx<QueueItem[]>(db, QUEUE, 'readonly',
      s => s.index('status').getAll(IDBKeyRange.only(status)) as IDBRequest<QueueItem[]>)
  } finally { db.close() }
}

export async function updateQueueItem(id: number, patch: Partial<QueueItem>): Promise<void> {
  if (!hasIDB()) return
  const db = await openDb()
  try {
    const rec = await tx<QueueItem | undefined>(db, QUEUE, 'readonly', s => s.get(id))
    if (rec) await tx(db, QUEUE, 'readwrite', s => s.put({ ...rec, ...patch, id }))
  } finally { db.close() }
}

/** Count of queue items in a status, via the `status` index (no full scan). */
export async function countByStatus(status: QueueStatus): Promise<number> {
  if (!hasIDB()) return 0
  const db = await openDb()
  try {
    return await tx<number>(db, QUEUE, 'readonly',
      s => s.index('status').count(IDBKeyRange.only(status)))
  } finally { db.close() }
}

export async function countPending(): Promise<number> {
  return countByStatus('pending')
}

/**
 * Has the attendee already been recorded as checked-in in any queued item?
 * Uses the `ticketCode` index so this is O(matches) instead of a full queue scan
 * (called on every offline scan).
 */
export async function isQueued(ticketCode: string): Promise<boolean> {
  if (!hasIDB()) return false
  const db = await openDb()
  try {
    const items = await tx<QueueItem[]>(db, QUEUE, 'readonly',
      s => s.index('ticketCode').getAll(IDBKeyRange.only(ticketCode)) as IDBRequest<QueueItem[]>)
    return items.some(i => i.status === 'pending' || i.status === 'synced')
  } finally { db.close() }
}
