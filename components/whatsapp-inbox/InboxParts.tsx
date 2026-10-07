'use client'

// WhatsApp Inbox — shared presentational parts (Phase 1c extraction).
//
// Moved VERBATIM out of the organizer Inbox (app/(dashboard)/dashboard/inbox/InboxClient.tsx)
// so the Super Admin Inbox renders conversations and threads with the SAME components rather
// than a copy. The only change is on ConversationRow: an optional `subtitle` and
// `unreadCount`, which the organizer Inbox does not pass (its rendering is unchanged).
//
// Pure presentation: no fetching, no authorization, no knowledge of who is looking.

import {
  CornerUpLeft, User, FileText, Film, Image as ImageIcon, Lock, MapPin, Mic, Send, Smile, Sticker,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Badge, Button, Skeleton } from '@/components/ui'
import { fieldControl } from '@/components/ui/field'
import { relativeTime } from '@/components/dashboard/notifications/presentation'
import type { ConversationListItem, InboxMessageView } from '@/lib/whatsapp-inbox/types'

export function displayName(c: Pick<ConversationListItem, 'attendeeName' | 'attendeePhone'>): string {
  return c.attendeeName || c.attendeePhone || 'Unknown sender'
}

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '#'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

function dayLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const yest  = new Date(); yest.setDate(today.getDate() - 1)
  const same  = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, yest))  return 'Yesterday'
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

const timeOf = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : ''

// ─── List pane ────────────────────────────────────────────────────────────────

export function ConversationRow({ c, active, onOpen, subtitle, unreadCount }: {
  c:        ConversationListItem
  active:   boolean
  onOpen:   (id: string) => void
  /** Second line. Defaults to the event name; the Super Admin inbox passes "Organizer · Event". */
  subtitle?: string | null
  /** Unread to display. Defaults to the organizer's count; the Super Admin passes its own. */
  unreadCount?: number
}) {
  const name   = displayName(c)
  const count  = unreadCount ?? c.unreadCount
  const unread = count > 0
  const second = subtitle === undefined ? c.eventName : subtitle
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(c.id)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'relative flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
          active ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
        )}
      >
        {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" aria-hidden />}
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-pill text-fs-xs font-semibold',
            unread ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
          )}
          aria-hidden
        >
          {c.attendeeName ? initials(c.attendeeName) : <User className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('truncate text-fs-sm text-foreground', unread ? 'font-semibold' : 'font-medium')}>{name}</span>
            <span className="ml-auto shrink-0 text-fs-2xs text-muted-foreground tabular-nums">{relativeTime(c.lastMessageAt)}</span>
          </span>
          {second && <span className="mt-0.5 block truncate text-fs-2xs text-muted-foreground">{second}</span>}
          <span className="mt-1 flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-fs-xs', unread ? 'text-foreground' : 'text-muted-foreground')}>
              {c.lastMessagePreview}
            </span>
            {unread && (
              <span className="min-w-5 shrink-0 rounded-pill bg-primary px-1.5 text-center text-fs-2xs font-semibold leading-5 text-primary-foreground tabular-nums">
                {count > 99 ? '99+' : count}
                <span className="sr-only"> unread</span>
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}

export function ListSkeleton() {
  return (
    <ul aria-hidden className="divide-y divide-border">
      {Array.from({ length: 7 }, (_, i) => (
        <li key={i} className="flex gap-3 px-4 py-3">
          <Skeleton className="size-9 rounded-pill" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── Thread pane ──────────────────────────────────────────────────────────────

const MEDIA_META: Record<string, { icon: typeof ImageIcon; label: string }> = {
  image:    { icon: ImageIcon, label: 'Photo' },
  document: { icon: FileText,  label: 'Document' },
  audio:    { icon: Mic,       label: 'Voice message' },
  video:    { icon: Film,      label: 'Video' },
  sticker:  { icon: Sticker,   label: 'Sticker' },
}

export function MessageBody({ m }: { m: InboxMessageView }) {
  const media = MEDIA_META[m.type]
  if (media) {
    const Icon = media.icon
    const detail = m.media?.filename ?? m.media?.caption
    return (
      <div className="space-y-1">
        <span className="flex items-center gap-2 text-fs-sm font-medium text-foreground">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {media.label}
        </span>
        {detail && <p className="whitespace-pre-wrap break-words text-fs-sm text-foreground">{detail}</p>}
        <p className="text-fs-2xs text-muted-foreground">Media preview isn’t available in the Inbox yet.</p>
      </div>
    )
  }
  if (m.type === 'location' && m.location) {
    const { latitude, longitude } = m.location
    return (
      <div className="space-y-1">
        <span className="flex items-center gap-2 text-fs-sm font-medium text-foreground">
          <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {m.text || 'Shared location'}
        </span>
        <a
          href={`https://www.google.com/maps?q=${latitude},${longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fs-xs font-medium text-primary hover:underline"
        >
          Open in Maps
        </a>
      </div>
    )
  }
  if (m.type === 'reaction') {
    return (
      <span className="flex items-center gap-2 text-fs-sm text-muted-foreground">
        <Smile className="size-4 shrink-0" aria-hidden />
        {m.text ? <>Reacted {m.text} to your message</> : 'Removed a reaction'}
      </span>
    )
  }
  if (m.type === 'unsupported' || !m.text) {
    return <span className="text-fs-sm italic text-muted-foreground">This message type isn’t supported yet.</span>
  }
  return <p className="whitespace-pre-wrap break-words text-fs-sm leading-relaxed text-foreground">{m.text}</p>
}

export function Thread({ messages }: { messages: InboxMessageView[] }) {
  return (
    <ol className="space-y-2">
      {messages.map((m, i) => {
        const day = dayLabel(m.sentAt)
        const showDay = Boolean(day) && (i === 0 || dayLabel(messages[i - 1].sentAt) !== day)
        const inbound = m.direction === 'inbound'
        return (
          <li key={m.id}>
            {showDay && (
              <div className="my-4 flex items-center gap-3" role="separator" aria-label={day}>
                <span className="h-px flex-1 bg-border" />
                <span className="text-fs-2xs font-medium text-muted-foreground">{day}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div className={cn('flex', inbound ? 'justify-start' : 'justify-end')}>
              <div
                className={cn(
                  'max-w-md rounded-lg border px-3.5 py-2.5 sm:max-w-lg',
                  inbound ? 'border-border bg-muted/40' : 'border-primary/20 bg-primary/[0.06]',
                )}
              >
                {m.hasContext && m.type !== 'reaction' && (
                  <span className="mb-1 flex items-center gap-1 text-fs-2xs text-muted-foreground">
                    <CornerUpLeft className="size-3" aria-hidden /> Replied to your message
                  </span>
                )}
                <MessageBody m={m} />
                <span className="mt-1 block text-right text-fs-2xs text-muted-foreground tabular-nums">{timeOf(m.sentAt)}</span>
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function ComingSoonComposer() {
  return (
    <div className="shrink-0 border-t border-border bg-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <Lock className="size-3" aria-hidden /> Coming Soon
        </Badge>
        <span className="text-fs-2xs text-muted-foreground">Replying from RegisterDesk isn’t available yet.</span>
      </div>
      <div className="flex items-end gap-2">
        <label htmlFor="inbox-reply" className="sr-only">Reply (coming soon)</label>
        <textarea
          id="inbox-reply"
          rows={1}
          disabled
          placeholder="Replies are coming soon"
          className={fieldControl({ className: 'h-10 min-h-10 resize-none py-2' })}
        />
        <Button type="button" size="md" disabled aria-label="Send (coming soon)">
          <Send className="size-4" aria-hidden />
          <span className="hidden sm:inline">Send</span>
        </Button>
      </div>
    </div>
  )
}
