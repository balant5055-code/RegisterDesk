'use client'

// ─── Brand wordmarks ──────────────────────────────────────────────────────────
// Monochrome SVG logos — one per industry vertical.
// Rendered at opacity-30 (grayscale) with a hover lift to opacity-60.

const BRANDS = [
  {
    id:    'corporate',
    label: 'Corporate',
    svg: (
      <svg viewBox="0 0 120 36" fill="currentColor" className="h-[22px] w-auto" aria-hidden>
        <rect x="0" y="6" width="8" height="24" rx="1.5" />
        <rect x="12" y="0" width="8" height="36" rx="1.5" />
        <rect x="24" y="10" width="8" height="16" rx="1.5" />
        <text x="40" y="26" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif"
          letterSpacing="-0.02em">
          Summit Co.
        </text>
      </svg>
    ),
  },
  {
    id:    'ngo',
    label: 'NGO',
    svg: (
      <svg viewBox="0 0 130 36" fill="currentColor" className="h-[22px] w-auto" aria-hidden>
        <circle cx="12" cy="18" r="10" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="M12 8 L18 18 L12 28 L6 18 Z" />
        <text x="30" y="26" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif"
          letterSpacing="-0.02em">
          GiveMore
        </text>
      </svg>
    ),
  },
  {
    id:    'sports',
    label: 'Sports',
    svg: (
      <svg viewBox="0 0 110 36" fill="currentColor" className="h-[22px] w-auto" aria-hidden>
        <path d="M4 28 L12 4 L20 18 L28 4 L36 28" fill="none" stroke="currentColor"
          strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <text x="44" y="26" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif"
          letterSpacing="-0.02em">
          Sporta
        </text>
      </svg>
    ),
  },
  {
    id:    'conference',
    label: 'Conference',
    svg: (
      <svg viewBox="0 0 148 36" fill="currentColor" className="h-[22px] w-auto" aria-hidden>
        <rect x="0" y="2" width="30" height="22" rx="3" fill="none" stroke="currentColor"
          strokeWidth="2.5" />
        <rect x="4" y="6" width="10" height="10" rx="1.5" />
        <rect x="16" y="6" width="10" height="5" rx="1" />
        <rect x="16" y="14" width="7" height="2.5" rx="1" />
        <path d="M5 28 L15 28 L25 28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <text x="40" y="26" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif"
          letterSpacing="-0.02em">
          ConfHub
        </text>
      </svg>
    ),
  },
  {
    id:    'education',
    label: 'Education',
    svg: (
      <svg viewBox="0 0 130 36" fill="currentColor" className="h-[22px] w-auto" aria-hidden>
        <path d="M2 15 L18 6 L34 15 L18 24 Z" />
        <path d="M28 18 L28 28 C24 32 12 32 8 28 L8 18" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" />
        <text x="42" y="26" fontSize="18" fontWeight="700" fontFamily="system-ui,sans-serif"
          letterSpacing="-0.02em">
          EduFest
        </text>
      </svg>
    ),
  },
] as const

// ─── Component ────────────────────────────────────────────────────────────────

export default function TrustStrip() {
  return (
    <section
      className="w-full border-b border-slate-100 bg-white py-10"
      aria-label="Trusted by organizers across industries"
    >
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">

        {/* Label */}
        <p className="text-center text-[11px] font-semibold uppercase tracking-[0.13em] text-slate-400">
          Trusted by organizers across industries
        </p>

        {/* Logo row */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-10 gap-y-6 sm:gap-x-14">
          {BRANDS.map(brand => (
            <div
              key={brand.id}
              title={brand.label}
              className="text-slate-900 opacity-[0.55] transition-opacity duration-300 hover:opacity-[0.85]"
            >
              {brand.svg}
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
