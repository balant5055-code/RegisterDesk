import type { MediaAsset } from '@/components/wizard/eventDetailsConfig'

export function CommunityGallerySection({ gallery }: {
  gallery: MediaAsset[]
}) {
  const images = gallery.filter(img => img.value?.trim()).slice(0, 4)
  if (images.length === 0) return null

  return (
    <section className="py-8 sm:py-10" aria-label="Gallery">
      <p className="mb-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Past Gatherings
      </p>

      {images.length === 1 && (
        <div className="overflow-hidden rounded-2xl bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={images[0]!.value}
            alt={images[0]!.originalFileName ?? 'Community gathering'}
            className="aspect-video w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
            loading="lazy"
          />
        </div>
      )}

      {images.length === 2 && (
        <div className="grid grid-cols-2 gap-2">
          {images.map((img, i) => (
            <div key={i} className="overflow-hidden rounded-2xl bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.value}
                alt={img.originalFileName ?? `Photo ${i + 1}`}
                className="aspect-square w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}

      {images.length >= 3 && (
        /* Featured editorial layout: large left, 2 stacked right */
        <div
          className="grid gap-2"
          style={{ height: '280px', gridTemplateColumns: '2fr 1fr', gridTemplateRows: '1fr 1fr' }}
        >
          <div className="overflow-hidden rounded-2xl bg-muted" style={{ gridRow: '1 / 3' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[0]!.value}
              alt={images[0]!.originalFileName ?? 'Featured photo'}
              className="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
              loading="lazy"
            />
          </div>

          <div className="overflow-hidden rounded-2xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[1]!.value}
              alt={images[1]!.originalFileName ?? 'Photo 2'}
              className="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
              loading="lazy"
            />
          </div>

          <div className="overflow-hidden rounded-2xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[2]!.value}
              alt={images[2]!.originalFileName ?? 'Photo 3'}
              className="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
              loading="lazy"
            />
          </div>
        </div>
      )}
    </section>
  )
}
