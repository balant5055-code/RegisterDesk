import type { PassPublic } from '@/components/event-templates/types'

export function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

export function formatDateShort(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export function formatTime(timeStr: string): string {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12  = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(amount)
}

export function minPassPrice(passes: PassPublic[]): number {
  const active = passes.filter(p => p.status !== 'inactive')
  return active.length > 0 ? Math.min(...active.map(p => p.price ?? 0)) : 0
}

// ─── Video embed normalisation ────────────────────────────────────────────────
// SINGLE source of truth for turning any organiser-pasted video URL into a
// frameable EMBED url. Every promo-video render path (public event page,
// templates, and the wizard preview) MUST use this so a raw watch/share URL is
// never framed directly (YouTube's watch page sets X-Frame-Options and would be
// blocked). The embed origins are also allow-listed in next.config.ts frame-src.
//
// Supported YouTube inputs (with or without scheme, extra query params ignored):
//   youtu.be/ID · youtu.be/ID?si=… · youtube.com/watch?v=ID ·
//   youtube.com/watch?v=ID&t=… · youtube.com/embed/ID · youtube.com/shorts/ID ·
//   youtube.com/live/ID · youtube.com/v/ID · m./www./youtube-nocookie variants
// Vimeo:  vimeo.com/ID · vimeo.com/video/ID · player.vimeo.com/video/ID
// Returns https://www.youtube.com/embed/ID or https://player.vimeo.com/video/ID,
// or null when the URL is not a recognised YouTube/Vimeo link.

const YT_ID = /^[a-zA-Z0-9_-]{11}$/

export function getVideoEmbed(url: string): string | null {
  const raw = url?.trim()
  if (!raw) return null

  // Accept URLs pasted without a scheme (e.g. "youtu.be/ID").
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  try {
    const u        = new URL(withScheme)
    const host     = u.hostname.toLowerCase().replace(/^www\./, '')
    const segments = u.pathname.split('/').filter(Boolean)

    // ── YouTube ──
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com'
        || host.endsWith('.youtube.com')) {
      let id: string | null = null
      if (host === 'youtu.be') {
        id = segments[0] ?? null                                   // youtu.be/ID (?si stripped)
      } else {
        id = u.searchParams.get('v')                               // watch?v=ID (&t=… ignored)
        if (!id && ['embed', 'shorts', 'live', 'v'].includes(segments[0] ?? '')) {
          id = segments[1] ?? null                                 // /embed|shorts|live|v/ID
        }
      }
      if (id && YT_ID.test(id)) {
        return `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`
      }
    }

    // ── Vimeo ──
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = segments.find(seg => /^\d+$/.test(seg))            // vimeo.com/ID or /video/ID
      if (id) return `https://player.vimeo.com/video/${id}?byline=0&portrait=0`
    }
  } catch {
    // Malformed URL → fall through to the regex fallback below.
  }

  // ── Regex fallback (inputs the URL parser cannot handle) ──
  const yt = raw.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^\s#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?rel=0&modestbranding=1`
  const vm = raw.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (vm) return `https://player.vimeo.com/video/${vm[1]}?byline=0&portrait=0`

  return null
}
