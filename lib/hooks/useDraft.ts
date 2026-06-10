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

/**
 * Manages a single event-draft document in Firestore.
 *
 * On mount it looks up the stored draftId in localStorage:
 *   - If found and the document exists in Firestore → restores that draft.
 *   - Otherwise → creates a fresh blank draft and stores the new id.
 *
 * Exposes `updateDraft` for fire-and-forget partial saves.
 */
export function useDraft() {
  const [draft,     setDraft]     = useState<EventDraftDocument | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Keep uid + draftId in refs so closures always see the latest values
  const uidRef     = useRef<string | null>(null)
  const draftIdRef = useRef<string | null>(null)

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
        // Try to rehydrate an existing draft
        if (storedId) {
          const existing = await loadEventDraft(user.uid, storedId)
          if (existing) {
            draftIdRef.current = storedId
            setDraft(existing)
            setIsLoading(false)
            return
          }
        }

        // No valid draft found — create a fresh one
        const newId = await createEventDraft(user.uid)
        localStorage.setItem(DRAFT_KEY, newId)
        draftIdRef.current = newId

        // Build local blank draft to avoid a second Firestore round-trip
        setDraft({
          id:               newId,
          status:           'draft',
          currentStep:      0,
          completedValues:  Array(7).fill(null),
          eventType:          null,
          eventSubtype:       null,
          customEventSubtype: null,
          visibility:         null,
          accessControl:    null,
          pricing:          null,
          registrationForm: null,
          eventDetails:     {},
          communicationBilling: null,
          publishedAt:          null,
          createdAt:        null,
          updatedAt:        null,
        })
      } catch (err) {
        // Fail gracefully — wizard still works, persistence is best-effort
        console.error('[useDraft] init failed:', err)
      } finally {
        setIsLoading(false)
      }
    })

    return () => unsubscribe()
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

  return { draft, isLoading, updateDraft }
}
