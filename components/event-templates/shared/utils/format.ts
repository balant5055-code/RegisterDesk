import type { PassPublic } from '@/components/event-templates/types'

/**
 * The calendar date inside a stored date string, or null when there isn't one.
 *
 * WHY THIS EXISTS. Both formatters below used to do `dateStr.split('-').map(Number)`,
 * which assumes the value is exactly 'YYYY-MM-DD'. Pass sales windows are not stored that
 * way: `salesStartDate` / `salesEndDate` come from `<input type="datetime-local">` and are
 * persisted in its native 'YYYY-MM-DDTHH:mm' form (the live NOYYAL event stores
 * "2026-08-14T23:00"). Splitting that on '-' yields ['2026','08','14T23:00'], the third
 * part is NaN, `new Date(2026, 7, NaN)` is an Invalid Date, and toLocaleDateString renders
 * the literal string "Invalid Date" straight into the page.
 *
 * Reading only the leading date portion accepts BOTH shapes, and returning null for
 * anything unrecognised means no caller can ever print "Invalid Date" again — the
 * formatters degrade to '' exactly as they already did for an empty input.
 *
 * Date-only is deliberate: these are wall-clock calendar values with no timezone, and
 * `resolvePassSaleState` (lib/registrations/salesWindow.ts) compares them date-first too,
 * so display and the sales gate stay consistent. No timezone conversion is introduced.
 */
function parseCalendarDate(value: string | null | undefined): Date | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(raw)
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d))
  // Rejects impossible calendar values (e.g. 2026-13-40) rather than letting JS roll them over.
  if (Number.isNaN(date.getTime())) return null
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null
  return date
}

export function formatDate(dateStr: string): string {
  const d = parseCalendarDate(dateStr)
  if (!d) return ''
  return d.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

export function formatDateShort(dateStr: string): string {
  const d = parseCalendarDate(dateStr)
  if (!d) return ''
  return d.toLocaleDateString('en-IN', {
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

// C2: the price to DISPLAY for a pass — its server-resolved early-bird effective
// price when present, otherwise the regular price. This is the ONE display accessor;
// every event-details surface (ticket cards, "from ₹" hero, sticky, JSON-LD) reads it
// so the amount shown always matches the amount the checkout charges. Pure field read
// (no Date.now()) — the early-bird resolution already happened server-side.
export function passDisplayPrice(pass: PassPublic): number {
  return pass.effectivePrice ?? pass.price
}

export function minPassPrice(passes: PassPublic[]): number {
  const active = passes.filter(p => p.status !== 'inactive')
  return active.length > 0 ? Math.min(...active.map(p => passDisplayPrice(p) ?? 0)) : 0
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
