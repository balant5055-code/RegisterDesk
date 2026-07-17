// Organizer Notification Center — metadata-driven catalog (Phase H.4.3).
//
// One declarative table drives BOTH classification and rendering. Nothing about
// a category's presentation is hardcoded in the UI: the client reads `iconKey`
// and `defaultSeverity` from here, and the feed API reads `visibility` to gate
// categories per the caller's team permissions (permission-aware, reusing the
// existing TeamPermission matrix). Pure and dependency-light so it also runs
// under tsx for unit tests.

import type { TeamPermission } from '@/lib/team/types'
import type { NotificationCategory, NotificationSeverity } from './types'

export interface CategoryMeta {
  category:        NotificationCategory
  label:           string               // group label in the filter UI
  iconKey:         string               // client maps this to a lucide icon
  defaultSeverity: NotificationSeverity
  // Team permission required to SEE this category. `null` = every workspace
  // member (owner always sees everything). Reuses the existing permission matrix
  // so finance-sensitive items stay scoped.
  visibility:      TeamPermission | null
}

export const CATEGORY_META: Record<NotificationCategory, CategoryMeta> = {
  approval:     { category: 'approval',     label: 'Approvals',     iconKey: 'badge-check',   defaultSeverity: 'info',    visibility: 'events'        },
  payment:      { category: 'payment',      label: 'Payments',      iconKey: 'credit-card',   defaultSeverity: 'success', visibility: 'registrations' },
  wallet:       { category: 'wallet',       label: 'Wallet',        iconKey: 'wallet',        defaultSeverity: 'info',    visibility: 'wallet'        },
  registration: { category: 'registration', label: 'Registrations', iconKey: 'ticket',        defaultSeverity: 'info',    visibility: 'registrations' },
  certificate:  { category: 'certificate',  label: 'Certificates',  iconKey: 'award',         defaultSeverity: 'success', visibility: 'certificates'  },
  broadcast:    { category: 'broadcast',    label: 'Broadcasts',    iconKey: 'megaphone',     defaultSeverity: 'info',    visibility: 'broadcasts'    },
  settlement:   { category: 'settlement',   label: 'Settlements',   iconKey: 'banknote',      defaultSeverity: 'info',    visibility: 'settlements'   },
  system:       { category: 'system',       label: 'Announcements', iconKey: 'megaphone',     defaultSeverity: 'info',    visibility: null            },
  alert:        { category: 'alert',        label: 'Alerts',        iconKey: 'alert-triangle',defaultSeverity: 'warning', visibility: null            },
}

export const NOTIFICATION_CATEGORIES = Object.keys(CATEGORY_META) as NotificationCategory[]

export function categoryMeta(category: NotificationCategory): CategoryMeta {
  return CATEGORY_META[category]
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_META, value)
}

/**
 * Whether a caller holding `permissions` may see `category`.
 * `owner` holds every permission, so it always passes.
 */
export function canSeeCategory(category: NotificationCategory, permissions: TeamPermission[]): boolean {
  const need = CATEGORY_META[category].visibility
  return need === null || permissions.includes(need)
}

/** The categories visible to a caller — used to server-filter the feed. */
export function visibleCategories(permissions: TeamPermission[]): NotificationCategory[] {
  return NOTIFICATION_CATEGORIES.filter(c => canSeeCategory(c, permissions))
}
