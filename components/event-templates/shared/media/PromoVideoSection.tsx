// PromoVideoSection — the organiser's promo video.
//
// RD-ST4.4 (ST41-C02 / ST41-B01 container half): this used to hand-roll its own
// `max-w-4xl` container — a width used nowhere else on the page — and every caller had
// to pass a className to re-declare the section's border, background and padding. It now
// sits on the ONE canonical SectionShell like every other section, so its content starts
// at exactly the same x. It still renders no header: adding one would be new content,
// which belongs to a later phase, not this foundation sprint.

import { getVideoEmbed } from '@/components/event-templates/shared/utils/format'
import { SectionShell } from '@/components/event-templates/shared/ui/framework'

export function PromoVideoSection({ promoVideoUrl, className }: {
  promoVideoUrl: string
  /** @deprecated The shell owns padding/border/background now. */
  className?:    string
}) {
  const embedUrl = getVideoEmbed(promoVideoUrl)
  if (!embedUrl) return null

  return (
    <SectionShell id="video" measure="narrow" className={className}>
      <div className="overflow-hidden rounded-2xl bg-black shadow-lg">
        <div className="relative" style={{ paddingBottom: '56.25%' }}>
          <iframe
            src={embedUrl}
            className="absolute inset-0 h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title="Event promo video"
          />
        </div>
      </div>
    </SectionShell>
  )
}
