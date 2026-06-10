'use client'

import { Mail, MessageCircle, Phone, CheckCircle2, Info, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { calculateCommunicationCost } from '@/lib/events/communicationCost'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatINR(rupees: number): string {
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ─── Channel row ─────────────────────────────────────────────────────────────

function ChannelRow({
  icon: Icon,
  label,
  desc,
  badge,
  badgeCls,
  meta,
  enabled = true,
}: {
  icon:     React.ElementType
  label:    string
  desc:     string
  badge:    string
  badgeCls: string
  meta?:    string
  enabled?: boolean
}) {
  return (
    <div className={cn(
      'flex items-start gap-4 rounded-xl border border-border bg-card p-4',
      !enabled && 'opacity-60',
    )}>
      <div className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl',
        enabled ? 'bg-primary/10' : 'bg-muted',
      )}>
        <Icon className={cn('size-4', enabled ? 'text-primary' : 'text-muted-foreground')} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[15px] font-semibold text-foreground">{label}</p>
          <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-bold', badgeCls)}>
            {badge}
          </span>
        </div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{desc}</p>
        {meta && (
          <p className="mt-1 text-[13px] font-medium text-muted-foreground">{meta}</p>
        )}
      </div>
    </div>
  )
}

// ─── Billing note ─────────────────────────────────────────────────────────────

function BillingNote({ isFreeEvent }: { isFreeEvent: boolean }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3">
      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-[13px] text-muted-foreground">
        {isFreeEvent
          ? 'WhatsApp and SMS charges are deducted from your organizer wallet when messages are sent.'
          : 'WhatsApp and SMS charges are deducted from your event settlement after the event concludes. No upfront payment required.'}
      </p>
    </div>
  )
}

// ─── Cost estimate ────────────────────────────────────────────────────────────

function CostEstimate({
  estimatedCapacity,
  whatsappEnabled,
  smsEnabled,
  isFreeEvent,
}: {
  estimatedCapacity: number
  whatsappEnabled:   boolean
  smsEnabled:        boolean
  isFreeEvent:       boolean
}) {
  if (!whatsappEnabled && !smsEnabled) return null

  const cost = calculateCommunicationCost({ estimatedCapacity, whatsappEnabled, smsEnabled })

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Estimated Communication Cost
        </p>
      </div>
      <div className="divide-y divide-border/40">
        <div className="flex items-center justify-between px-4 py-2.5 text-[14px]">
          <span className="text-muted-foreground">Estimated registrations</span>
          <span className="font-medium text-foreground">{estimatedCapacity.toLocaleString('en-IN')}</span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5 text-[14px]">
          <span className="text-muted-foreground">Messages per attendee</span>
          <span className="font-medium text-foreground">2 (confirmation + reminder)</span>
        </div>
        {whatsappEnabled && (
          <div className="flex items-center justify-between px-4 py-2.5 text-[14px]">
            <span className="text-muted-foreground">WhatsApp (₹0.10 / msg)</span>
            <span className="font-medium text-foreground">{formatINR(cost.whatsappCost)}</span>
          </div>
        )}
        {smsEnabled && (
          <div className="flex items-center justify-between px-4 py-2.5 text-[14px]">
            <span className="text-muted-foreground">SMS (₹0.15 / msg)</span>
            <span className="font-medium text-foreground">{formatINR(cost.smsCost)}</span>
          </div>
        )}
        <div className="flex items-center justify-between bg-muted/[0.04] px-4 py-3 text-[14px]">
          <span className="font-semibold text-foreground">Total Estimated</span>
          <span className="font-bold text-primary">{formatINR(cost.totalCost)}</span>
        </div>
      </div>
      <div className="border-t border-border/40 px-4 py-2.5">
        <p className="text-[13px] text-muted-foreground">
          {isFreeEvent
            ? 'Charged from your wallet when messages are sent. Actual cost depends on final registrations.'
            : 'Charged from settlement after event. Actual cost depends on final registrations.'}
        </p>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface Props {
  event: EventDetailResponse
  token: string
}

export default function CommunicationsTab({ event }: Props) {
  const pricing         = event.pricing as Record<string, unknown> | null
  const isFreeEvent     = event.isFreeEvent
  const whatsappEnabled = !!(pricing?.whatsappEnabled as boolean | undefined)
  const smsEnabled      = !!(pricing?.smsEnabled      as boolean | undefined)
  const hasCommChannels = whatsappEnabled || smsEnabled

  const estimatedCapacity = (event.totalCapacity ?? event.totalRegistrations) || 100

  return (
    <div className="space-y-5">

      {/* Email — always active */}
      <div>
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Channels
        </p>
        <div className="grid gap-3">
          <ChannelRow
            icon={Mail}
            label="Email Notifications"
            desc="Branded ticket confirmation, event reminders, and updates sent automatically to all attendees."
            badge="Active · Included"
            badgeCls="bg-emerald-100 text-emerald-700"
          />

          {whatsappEnabled ? (
            <ChannelRow
              icon={MessageCircle}
              label="WhatsApp Notifications"
              desc="Confirmation and reminder messages sent to attendees' WhatsApp numbers."
              badge="Active"
              badgeCls="bg-emerald-100 text-emerald-700"
              meta={isFreeEvent
                ? '₹0.10 / message · Charged from wallet'
                : '₹0.10 / message · Charged from settlement'}
            />
          ) : (
            <ChannelRow
              icon={MessageCircle}
              label="WhatsApp Notifications"
              desc="Not enabled for this event. Configure in event settings to activate."
              badge="Not enabled"
              badgeCls="bg-muted text-muted-foreground"
              enabled={false}
            />
          )}

          {smsEnabled ? (
            <ChannelRow
              icon={Phone}
              label="SMS Notifications"
              desc="Short text reminders delivered directly to attendees' mobile numbers."
              badge="Active"
              badgeCls="bg-emerald-100 text-emerald-700"
              meta={isFreeEvent
                ? '₹0.15 / message · Charged from wallet'
                : '₹0.15 / message · Charged from settlement'}
            />
          ) : (
            <ChannelRow
              icon={Phone}
              label="SMS Notifications"
              desc="Not enabled for this event. Configure in event settings to activate."
              badge="Not enabled"
              badgeCls="bg-muted text-muted-foreground"
              enabled={false}
            />
          )}
        </div>
      </div>

      {/* Cost estimate — only when comm channels are active */}
      {hasCommChannels && (
        <CostEstimate
          estimatedCapacity={estimatedCapacity}
          whatsappEnabled={whatsappEnabled}
          smsEnabled={smsEnabled}
          isFreeEvent={isFreeEvent}
        />
      )}

      {/* Billing note */}
      {hasCommChannels && <BillingNote isFreeEvent={isFreeEvent} />}

      {/* Wallet callout — free events only */}
      {isFreeEvent && hasCommChannels && (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Wallet className="size-4 text-primary" aria-hidden />
          </div>
          <div>
            <p className="text-[15px] font-semibold text-foreground">Organizer Wallet</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Communication charges for free events are deducted from your organizer wallet. Ensure your balance covers the estimated cost before the event to avoid message delivery issues.
            </p>
          </div>
        </div>
      )}

      {/* No comm channels placeholder */}
      {!hasCommChannels && (
        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
          <div>
            <p className="text-[15px] font-semibold text-foreground">Email notifications active</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Attendees receive email confirmations and reminders automatically. Enable WhatsApp or SMS in event settings for additional reach.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
