// Abuse report types (contentReports/{reportId}). Server + client safe.

export type ReportTargetType = 'event' | 'campaign' | 'organizer'
export type ReportStatus     = 'open' | 'reviewing' | 'actioned' | 'dismissed'

/** Firestore document at contentReports/{reportId}. */
export interface ContentReportDoc {
  id:             string
  targetType:     ReportTargetType
  targetId:       string
  reporterUid?:   string
  reporterEmail?: string
  reason:         string
  details?:       string
  status:         ReportStatus
  linkedActionId?: string
  resolution?:    string
  reviewedBy?:    string
  reviewedAt?:    unknown   // Firestore Timestamp
  createdAt:      unknown   // Firestore Timestamp
}

// ─── Public submission ───────────────────────────────────────────────────────

export interface SubmitReportBody {
  targetType: ReportTargetType
  targetId:   string
  reason:     string
  details?:   string
  email?:     string
}

// ─── Admin API shapes ────────────────────────────────────────────────────────

export interface AdminReportItem {
  id:            string
  targetType:    ReportTargetType
  targetId:      string
  targetTitle:   string          // resolved title/name of the target (best-effort)
  reason:        string
  details:       string | null
  status:        ReportStatus
  reporterEmail: string | null
  resolution:    string | null
  createdAt:     string | null   // ISO 8601
}

export interface AdminReportsListResponse {
  items:      AdminReportItem[]
  nextCursor: string | null
  openCount:  number
}

export interface AdminReportDetailResponse {
  report: AdminReportItem & {
    reporterUid:    string | null
    linkedActionId: string | null
    reviewedBy:     string | null
    reviewedAt:     string | null
  }
  target: {
    type:     ReportTargetType
    id:       string
    title:    string
    exists:   boolean
    /** Owning organizer uid (for event/campaign targets, or the organizer itself). */
    organizerUid: string | null
    /** Public URL for events/campaigns; null for organizers. */
    publicPath: string | null
  }
  relatedReports: AdminReportItem[]
}

export type AdminReportAction = 'reviewing' | 'dismiss' | 'take_down' | 'suspend'

export interface AdminReportPatchResponse {
  id:     string
  status: ReportStatus
}
