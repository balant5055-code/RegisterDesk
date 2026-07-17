'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import {
  createEventDraft,
  loadEventDraft,
  saveEventDraft,
  type EventDraftDocument,
  type DraftPayload,
} from '@/lib/firebase/firestore/drafts'

export type { EventDraftDocument, DraftPayload }

// localStorage key that stores the active draftId per browser
const DRAFT_KEY = 'rd_event_draft_id'

// Builds an in-memory representation of a freshly created draft so the UI can
// render immediately without a second Firestore round-trip. Mirrors the server
// blank template; `payload` overrides the wizard fields the caller seeded.
function localDraft(id: string, payload: DraftPayload): EventDraftDocument {
  return {
    id,
    status:           'draft',
    currentStep:      0,
    completedValues:  Array(9).fill(null),
    eventType:          null,
    eventSubtype:       null,
    customEventSubtype: null,
    campaignType:       null,
    linkedCampaign:     null,
    visibility:         null,
    accessControl:    null,
    pricing:          null,
    registrationForm: null,
    eventDetails:     {},
    communicationBilling: null,
    publishedAt:          null,
    createdAt:        null,
    updatedAt:        null,
    ...payload,
  }
}

/**
 * Manages a single event-draft document in Firestore.
 *
 * On mount it looks up the stored draftId in localStorage:
 *   - If found and the document exists in Firestore → restores that draft.
 *   - Otherwise → nothing is written. Creation is deferred to an explicit user
 *     action via `createDraft`, so merely opening the wizard never produces a
 *     ghost draft.
 *
 * Exposes `createDraft` (first write) and `updateDraft` (subsequent saves).
 */
export function useDraft() {
  const [draft,     setDraft]     = useState<EventDraftDocument | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Keep uid + draftId in refs so closures always see the latest values
  const uidRef      = useRef<string | null>(null)
  const draftIdRef  = useRef<string | null>(null)
  // Dedupes concurrent create calls (e.g. a double-clicked Continue button).
  const creatingRef = useRef<Promise<string | null> | null>(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async user => {
      if (!user) {
        // Not authenticated — skip persistence; wizard still functions
        setIsLoading(false)
        return
      }

      uidRef.current = user.uid
      const storedId = localStorage.getItem(DRAFT_KEY)

      try {
        // Try to rehydrate an existing draft (Resume Draft / refresh mid-wizard)
        if (storedId) {
          const existing = await loadEventDraft(user.uid, storedId)
          if (existing) {
            draftIdRef.current = storedId
            setDraft(existing)
            setIsLoading(false)
            return
          }
          // Stored id no longer resolves — drop it so we start clean.
          localStorage.removeItem(DRAFT_KEY)
        }

        // No existing draft. Intentionally create NOTHING here — the first
        // Firestore write happens only when the organizer clicks Continue
        // (see createDraft). This is what prevents accidental ghost drafts.
      } catch (err) {
        // Fail gracefully — wizard still works, persistence is best-effort
        console.error('[useDraft] init failed:', err)
      } finally {
        setIsLoading(false)
      }
    })

    return () => unsubscribe()
  }, [])

  /**
   * Creates the Firestore draft exactly once, seeded with `payload`, and returns
   * its id (or null if unauthenticated / the write failed). Deduped: repeated or
   * concurrent calls reuse the in-flight promise, so a double-click can never
   * create two drafts.
   */
  const createDraft = useCallback(async (payload: DraftPayload): Promise<string | null> => {
    const uid = uidRef.current
    if (!uid) return null
    if (draftIdRef.current)  return draftIdRef.current   // already created
    if (creatingRef.current) return creatingRef.current  // creation in flight — reuse

    const promise = (async () => {
      const newId = await createEventDraft(uid, payload)
      localStorage.setItem(DRAFT_KEY, newId)
      draftIdRef.current = newId
      setDraft(localDraft(newId, payload))
      return newId
    })()

    creatingRef.current = promise
    try {
      return await promise
    } catch (err) {
      console.error('[useDraft] createDraft failed:', err)
      creatingRef.current = null   // allow a retry after failure
      return null
    }
  }, [])

  /** Merges `payload` into Firestore and applies an optimistic local update. */
  const updateDraft = useCallback(async (payload: DraftPayload) => {
    const uid     = uidRef.current
    const draftId = draftIdRef.current
    if (!uid || !draftId) return

    // Optimistic local update so the UI reflects changes immediately
    setDraft(prev => (prev ? { ...prev, ...payload } : prev))

    try {
      await saveEventDraft(uid, draftId, payload)
    } catch (err) {
      console.error('[useDraft] save failed:', err)
    }
  }, [])

  return { draft, isLoading, createDraft, updateDraft }
}
