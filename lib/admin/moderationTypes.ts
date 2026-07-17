// API shapes for the admin event/campaign moderation endpoints.

import type { ModerationStatus } from '@/lib/admin/moderation'

/** A row in the admin moderation list (event or campaign). */
export interface AdminModerationItem {
  slug:             string
  title:            string
  organizerUid:     string
  organizerName:    string
  moderationStatus: ModerationStatus   // effective (missing → 'active')
  moderationReason: string | null
  publishedAt:      string | null      // ISO 8601
}

export interface AdminModerationListResponse {
  items:      AdminModerationItem[]
  nextCursor: string | null
}

export type AdminModerationAction = 'take_down' | 'restore' | 'under_review'

export interface AdminModerationPatchResponse {
  slug:             string
  moderationStatus: ModerationStatus
}
