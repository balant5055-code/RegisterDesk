// RD-PRODUCT-01G Phase 4 — Event Builder shared static CONSTANTS.
//
// Pure, runtime-free data extracted VERBATIM from the Event Builder monolith. These are
// static option/label/style data with NO component scope, closures, JSX, or icon-component
// values — so relocating them + importing back is byte-for-byte identical. (Presentation
// constants that embed icon components or read component state — OPEN_EXPERIENCE, BENEFITS,
// OPTIONAL_SERVICES — are intentionally NOT moved; they are not runtime-free.)

import type { WizardStep } from './types'

/** The framer-motion easing curve used across the builder's transitions. */
export const EASE = [0.22, 1, 0.36, 1] as const

/** The default (non-fundraising) wizard step sequence. Shared by every Step view + the
 *  parent navigation. RD-PRODUCT-01G Phase 5. */
export const WIZARD_STEPS: WizardStep[] = [
  { name: 'Event Type' },
  { name: 'Visibility' },
  { name: 'Access Control' },
  { name: 'Passes & Pricing' },
  { name: 'Form' },
  { name: 'Details' },
  { name: 'License' },
  { name: 'Review' },
]

/** Reasons shown when the organizer picks a PUBLIC event visibility. */
export const PUBLIC_REASONS = [
  'Your event is open to all',
  'You want more visibility',
  'Anyone can register',
  'You want to promote widely',
] as const

/** Reasons shown when the organizer picks a PRIVATE event visibility. */
export const PRIVATE_REASONS = [
  'Only selected people can attend',
  "It's a member-only event",
  'You want to control access',
  "You're hosting an internal event",
] as const

/** Rotating colour palette for pass cards (bg / text / dot). */
export const PASS_COLORS: { bg: string; color: string; dot: string }[] = [
  { bg: 'bg-violet-100',  color: 'text-violet-600',  dot: 'bg-violet-500'  },
  { bg: 'bg-blue-100',    color: 'text-blue-600',    dot: 'bg-blue-500'    },
  { bg: 'bg-emerald-100', color: 'text-emerald-600', dot: 'bg-emerald-500' },
  { bg: 'bg-orange-100',  color: 'text-orange-500',  dot: 'bg-orange-500'  },
  { bg: 'bg-rose-100',    color: 'text-rose-600',    dot: 'bg-rose-500'    },
  { bg: 'bg-purple-100',  color: 'text-purple-600',  dot: 'bg-purple-500'  },
  { bg: 'bg-cyan-100',    color: 'text-cyan-600',    dot: 'bg-cyan-500'    },
]
