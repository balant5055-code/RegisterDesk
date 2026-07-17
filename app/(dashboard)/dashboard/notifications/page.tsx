import { NotificationCenter } from '@/components/dashboard/NotificationCenter'

// Organizer Notification Center (Phase H.4.3) — the inbox of platform events.
// Distinct from the Communication Center (/dashboard/communications/notifications),
// which is the outbound delivery log.
export default function NotificationsPage() {
  return <NotificationCenter />
}
