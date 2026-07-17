import { cn } from '@/lib/utils/cn'
import type { MediaAsset } from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUBTYPE_TAGS: Record<string, string[]> = {
  'rotary':            ['Service Leaders', 'Community Volunteers', 'District Members'],
  'startup-meetup':    ['Founders', 'Investors', 'Builders', 'Product Managers'],
  'startup_meetup':    ['Founders', 'Investors', 'Builders', 'Product Managers'],
  'business-meetup':   ['Entrepreneurs', 'Executives', 'Professionals'],
  'business_meetup':   ['Entrepreneurs', 'Executives', 'Professionals'],
  'networking':        ['Professionals', 'Industry Leaders', 'Career Builders'],
  'foundation':        ['Social Leaders', 'NGO Partners', 'Changemakers'],
  'community-program': ['Volunteers', 'Community Members', 'Local Leaders'],
  'community_program': ['Volunteers', 'Community Members', 'Local Leaders'],
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NetworkingProfileSection({
  gallery, showGallery, eventSubtype,
}: {
  gallery:       MediaAsset[]
  showGallery:   boolean
  eventSubtype?: string
}) {
  const images = showGallery ? gallery.filter(img => img.value?.trim()) : []
  const tags   = eventSubtype ? (SUBTYPE_TAGS[eventSubtype.toLowerCase()] ?? []) : []

  if (tags.length === 0 && images.length === 0) return null

  const gridCols =
    images.length === 1 ? 'grid-cols-1' :
    images.length === 2 ? 'grid-cols-2' :
    'grid-cols-2 sm:grid-cols-4'

  return (
    <SectionWrapper title="Community">

      {/* Audience tags */}
      {tags.length > 0 && (
        <div>
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            Who Attends
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map(tag => (
              <span
                key={tag}
                className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Gallery grid */}
      {images.length > 0 && (
        <div className={cn('grid gap-2', tags.length > 0 && 'mt-5', gridCols)}>
          {images.slice(0, 4).map((img, i) => (
            <div key={i} className="overflow-hidden rounded-xl bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.value}
                alt={img.originalFileName ?? `Community photo ${i + 1}`}
                className="aspect-[4/3] w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}

    </SectionWrapper>
  )
}
