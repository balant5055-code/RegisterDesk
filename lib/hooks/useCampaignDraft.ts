'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import {
  createCampaignDraft,
  loadCampaignDraft,
  saveCampaignDraft,
  type CampaignDraftDocument,
  type CampaignDraftPayload,
} from '@/lib/firebase/firestore/campaignDrafts'
import type { CampaignType } from '@/lib/campaigns/campaignDetailsConfig'

export type { CampaignDraftDocument, CampaignDraftPayload }

// localStorage key for active campaign draft id — separate from event drafts
const CAMPAIGN_DRAFT_KEY = 'rd_campaign_draft_id'

const CAMPAIGN_DRAFT_STEPS = 4

interface UseCampaignDraftOptions {
  campaignType?: CampaignType
  eventSubtype?: string | null
}

/**
 * Manages a single campaign-draft document in Firestore.
 * Uses the `users/{uid}/campaignDrafts/{draftId}` collection.
 *
 * On mount:
 *   - Looks up the stored draftId in localStorage.
 *   - If found and unpublished → restores that draft.
 *   - Otherwise → creates a fresh blank draft.
 *
 * `resetDraft` discards the current draft and starts fresh.
 * Used when the user changes campaign type from the event wizard step 0.
 */
export function useCampaignDraft(opts?: UseCampaignDraftOptions) {
  const [draft,     setDraft]     = useState<CampaignDraftDocument | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const uidRef     = useRef<string | null>(null)
  const draftIdRef = useRef<string | null>(null)

  const blankDraft = useCallback((id: string): CampaignDraftDocument => ({
    id,
    status:           'draft',
    currentStep:      0,
    completedValues:  Array(CAMPAIGN_DRAFT_STEPS).fill(null),
    campaignType:     opts?.campaignType ?? 'donation_only',
    eventSubtype:     opts?.eventSubtype ?? null,
    visibility:       null,
    campaignDetails:  null,
    donationSettings: null,
    publishedCampaignId: null,
    publishedSlug:       null,
    createdAt:        null,
    updatedAt:        null,
  }), [opts?.campaignType, opts?.eventSubtype])

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async user => {
      if (!user) {
        setIsLoading(false)
        return
      }

      uidRef.current = user.uid
      const storedId = localStorage.getItem(CAMPAIGN_DRAFT_KEY)

      // ── Diagnostics ─────────────────────────────────────────────────────────
      console.log("Firebase Project:", auth.app.options.projectId)
      console.log("Current User UID:", auth.currentUser?.uid)
      console.log("Stored Draft ID:", storedId)
      // ────────────────────────────────────────────────────────────────────────

      try {
        if (storedId) {
          console.log('[useCampaignDraft] branch: load existing | uid:', user.uid, '| draftId:', storedId)
          const existing = await loadCampaignDraft(user.uid, storedId)
          // Only restore if draft is unpublished and matches the requested campaign type
          if (existing && existing.status !== 'published') {
            // If opts specify a subtype and it differs, create fresh draft
            if (opts?.eventSubtype && existing.eventSubtype && existing.eventSubtype !== opts.eventSubtype) {
              console.log('[useCampaignDraft] subtype mismatch — will create new draft')
              // subtype changed — fall through to create new
            } else {
              console.log('[useCampaignDraft] restored existing draft | draftId:', storedId)
              draftIdRef.current = storedId
              setDraft(existing)
              setIsLoading(false)
              return
            }
          } else {
            console.log('[useCampaignDraft] stored draft not usable (published or missing) — will create new')
          }
        }

        // No valid draft — create fresh
        console.log('[useCampaignDraft] branch: create new draft | uid:', user.uid)
        const newId = await createCampaignDraft(user.uid, {
          campaignType: opts?.campaignType,
          eventSubtype: opts?.eventSubtype,
        })
        console.log('[useCampaignDraft] created new draft | draftId:', newId)
        localStorage.setItem(CAMPAIGN_DRAFT_KEY, newId)
        draftIdRef.current = newId
        setDraft(blankDraft(newId))
      } catch (err) {
        console.error('[useCampaignDraft] FAILED | uid:', user.uid, '| storedId:', storedId, '| err:', err)
      } finally {
        setIsLoading(false)
      }
    })

    return () => unsubscribe()
  // opts are read once on mount — intentionally not in deps to avoid re-runs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Merges payload into Firestore and applies an optimistic local update. */
  const updateDraft = useCallback(async (payload: CampaignDraftPayload) => {
    const uid     = uidRef.current
    const draftId = draftIdRef.current
    if (!uid || !draftId) return

    setDraft(prev => (prev ? { ...prev, ...payload } : prev))

    try {
      await saveCampaignDraft(uid, draftId, payload)
    } catch (err) {
      console.error('[useCampaignDraft] save failed:', err)
    }
  }, [])

  /** Discards the current draft and creates a new blank one. */
  const resetDraft = useCallback(async () => {
    const uid = uidRef.current
    if (!uid) return
    localStorage.removeItem(CAMPAIGN_DRAFT_KEY)
    try {
      const newId = await createCampaignDraft(uid, {
        campaignType: opts?.campaignType,
        eventSubtype: opts?.eventSubtype,
      })
      localStorage.setItem(CAMPAIGN_DRAFT_KEY, newId)
      draftIdRef.current = newId
      setDraft(blankDraft(newId))
    } catch (err) {
      console.error('[useCampaignDraft] resetDraft failed:', err)
    }
  }, [opts?.campaignType, opts?.eventSubtype, blankDraft])

  return { draft, isLoading, updateDraft, resetDraft }
}
