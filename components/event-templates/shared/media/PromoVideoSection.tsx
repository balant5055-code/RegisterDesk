import { getVideoEmbed } from '@/components/event-templates/shared/utils/format'

export function PromoVideoSection({ promoVideoUrl, className }: {
  promoVideoUrl: string
  className?:    string
}) {
  const embedUrl = getVideoEmbed(promoVideoUrl)
  if (!embedUrl) return null

  return (
    <section className={className ?? 'bg-gray-50 py-10 sm:py-14'}>
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
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
      </div>
    </section>
  )
}
