// Phase P.1.3 — Homepage section registry.
//
// The homepage renders by ITERATING this ordered list (later phase) — the section
// order is never hardcoded inside page.tsx. Each entry declares its background
// band so vertical rhythm alternates consistently.

import type { HomeSection } from '@/lib/marketing/types'

export const HOME_SECTIONS: HomeSection[] = [
  { key: 'hero',         background: 'white',   enabled: true },
  { key: 'trust',        background: 'white',   enabled: true },
  { key: 'journey',      background: 'muted',   enabled: true },
  { key: 'platform',     background: 'white',   enabled: true },
  { key: 'modules',      background: 'muted',   enabled: true },
  { key: 'solutions',    background: 'white',   enabled: true },
  { key: 'workspace',    background: 'muted',   enabled: true },
  { key: 'participant',  background: 'white',   enabled: true },
  { key: 'security',     background: 'muted',   enabled: true },
  { key: 'integrations', background: 'white',   enabled: true },
  { key: 'pricing',      background: 'muted',   enabled: true },
  { key: 'faq',          background: 'white',   enabled: true },
  { key: 'cta',          background: 'inverse', enabled: true },
]

export const ENABLED_HOME_SECTIONS = HOME_SECTIONS.filter(s => s.enabled)
