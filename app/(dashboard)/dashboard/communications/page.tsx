'use client'

import Link from 'next/link'
import { Mail, Award, ArrowRight, Clock } from 'lucide-react'

// ─── Card ─────────────────────────────────────────────────────────────────────

function HubCard({
  icon: Icon,
  iconGradient,
  title,
  description,
  href,
  cta,
  badge,
}: {
  icon:          React.ElementType
  iconGradient?: boolean
  title:         string
  description:   string
  href:          string | null
  cta:           string
  badge?:        string
}) {
  const content = (
    <div className="group flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-xl"
          style={iconGradient ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
          aria-hidden
        >
          <Icon className={`size-5 ${iconGradient ? 'text-white' : 'text-primary'}`} />
        </div>
        {badge && (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
            {badge}
          </span>
        )}
      </div>

      <div className="flex-1">
        <h3 className="text-[15px] font-bold text-foreground">{title}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </div>

      <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${href ? 'text-primary' : 'text-muted-foreground'}`}>
        {cta}
        {href && <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />}
      </div>
    </div>
  )

  if (!href) return <div className="cursor-default opacity-70">{content}</div>
  return <Link href={href}>{content}</Link>
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CommunicationsHubPage() {
  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div>
        <h1 className="text-[32px] font-bold text-foreground">Communications</h1>
        <p className="mt-0.5 text-[14px] text-muted-foreground">
          Manage certificates and email communications for your attendees.
        </p>
      </div>

      {/* ── Hub cards ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <HubCard
          icon={Award}
          iconGradient
          title="Certificates"
          description="Generate participation and completion certificates for your attendees. Configure templates, track downloads, and send by email."
          href="/dashboard/communications/certificates"
          cta="View Certificates"
        />
        <HubCard
          icon={Mail}
          title="Email History"
          description="View all transactional emails sent to your attendees — ticket confirmations, reminders, and certificate delivery."
          href={null}
          cta="Coming soon"
          badge="Soon"
        />
      </div>

      {/* ── Info strip ── */}
      <div className="rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-[13px] font-medium text-foreground">More features coming soon</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              SMS notifications, WhatsApp reminders, and marketing campaigns are on the roadmap.
            </p>
          </div>
        </div>
      </div>

    </div>
  )
}
