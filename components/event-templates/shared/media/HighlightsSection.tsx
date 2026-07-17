import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import type { MediaAsset } from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'
import { getVideoEmbed } from '@/components/event-templates/shared/utils/format'

export function HighlightsSection({ promoVideoUrl, gallery, perks }: {
  promoVideoUrl: string
  gallery:       MediaAsset[]
  perks?:        { icon: ReactNode; label: string; sub?: string }[]
}) {
  const embedUrl = getVideoEmbed(promoVideoUrl)
  const images   = gallery.filter(img => img.value?.trim())
  const hasPerk  = perks && perks.length > 0
  if (!embedUrl && images.length === 0 && !hasPerk) return null

  return (
    <SectionWrapper title="Event Highlights">
      <div className="flex flex-col gap-5">
        {embedUrl && (
          <div className="overflow-hidden rounded-xl bg-black">
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
        )}

        {hasPerk && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {perks!.map(({ icon, label, sub }) => (
              <div
                key={label}
                className="flex flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-background p-2.5 text-center"
              >
                <span className="text-primary">{icon}</span>
                <div>
                  <p className="text-xs font-semibold text-foreground">{label}</p>
                  {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className={cn(
            'grid gap-2',
            images.length === 1 ? 'grid-cols-1'
              : images.length === 2 ? 'grid-cols-2'
              : 'grid-cols-2 sm:grid-cols-3',
          )}>
            {images.map((img, i) => (
              <div key={i} className="overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.value}
                  alt={img.originalFileName ?? `Highlight ${i + 1}`}
                  className="aspect-video w-full object-cover transition-transform duration-500 hover:scale-105"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionWrapper>
  )
}
