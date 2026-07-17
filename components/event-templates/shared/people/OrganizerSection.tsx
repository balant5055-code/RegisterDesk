import { Globe, Mail, Phone, ExternalLink, BadgeCheck, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'

export function OrganizerSection({ organizer, showSocial }: {
  organizer:  OrganizerInfo
  showSocial: boolean
}) {
  const socialLinks = showSocial ? [
    organizer.social?.instagram && { label: 'Instagram', url: organizer.social.instagram, color: 'hover:text-pink-500' },
    organizer.social?.facebook  && { label: 'Facebook',  url: organizer.social.facebook,  color: 'hover:text-blue-600' },
    organizer.social?.twitter   && { label: 'Twitter',   url: organizer.social.twitter,   color: 'hover:text-sky-500' },
    organizer.social?.linkedin  && { label: 'LinkedIn',  url: organizer.social.linkedin,  color: 'hover:text-blue-700' },
    organizer.social?.youtube   && { label: 'YouTube',   url: organizer.social.youtube,   color: 'hover:text-red-600' },
  ].filter(Boolean) as { label: string; url: string; color: string }[] : []

  return (
    <SectionWrapper id="organizer" title="Organizer">
      <div className="flex items-start gap-4">
        {/* Logo */}
        <div className="shrink-0">
          {organizer.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={organizer.logoUrl}
              alt={organizer.name}
              className="size-[64px] rounded-xl border border-border/60 bg-white object-contain p-1 shadow-[var(--shadow-sm)]"
            />
          ) : (
            <div
              className="flex size-[64px] items-center justify-center rounded-xl text-2xl font-extrabold text-white shadow-[var(--shadow-sm)]"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              {organizer.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-bold text-foreground">{organizer.name}</p>
            <BadgeCheck className="size-4 shrink-0 text-primary" aria-label="Verified organizer" />
          </div>

          {/* Contact links */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {organizer.website?.trim() && (
              <a
                href={organizer.website}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Globe className="size-3 shrink-0" aria-hidden />
                {organizer.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </a>
            )}
            {organizer.email?.trim() && (
              <a
                href={`mailto:${organizer.email}`}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Mail className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                {organizer.email}
              </a>
            )}
            {organizer.phone?.trim() && (
              <a
                href={`tel:${organizer.phone}`}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Phone className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                {organizer.phone}
              </a>
            )}
          </div>

          {/* Action buttons */}
          {(organizer.email || organizer.website) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {organizer.email && (
                <a
                  href={`mailto:${organizer.email}`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
                >
                  <Mail className="size-3.5" aria-hidden />
                  Contact Organizer
                  <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                </a>
              )}
            </div>
          )}

          {/* Social icons row */}
          {socialLinks.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              {socialLinks.map(({ label, url, color }) => (
                <a
                  key={label}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-muted-foreground transition-colors',
                    color,
                  )}
                >
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </SectionWrapper>
  )
}
