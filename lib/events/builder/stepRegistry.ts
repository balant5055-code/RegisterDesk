// RD-EVENT-02 · The Event Builder step registry — PURE.
//
// ═══ WHAT THIS REPLACES ═══════════════════════════════════════════════════════
// The wizard's step→draft-field mapping lived as positional `if (step === N)` chains in
// three separate places inside a 4,177-line page component, and the step ORDER is not fixed:
// it depends on the campaign type. Renumbering or inserting a step silently mis-saved a
// field, because nothing tied index 3 to `pricing` except a literal in three files.
//
// This declares each flow once. Index is derived from position; nothing hard-codes a number.
//
// ═══ THE THREE FLOWS ══════════════════════════════════════════════════════════
// They are genuinely different wizards, not variants of one:
//   standard     8 steps
//   fundraising  9 steps — 'Fundraising' inserted after Details
//   campaign     4 steps — donation-only; replaces the whole wizard
//
// ═══ WHY THREE PERSISTENCE FLAGS AND NOT ONE ══════════════════════════════════
// The three call sites do NOT persist the same set of steps, and that asymmetry is existing
// behaviour this registry must describe rather than "correct":
//
//   goNext     persists steps 0–5, plus 'Fundraising' — but NOT License and NOT Review
//   saveDraft  persists every step that has a key, including License and Review
//   autosave   persists only Passes & Pricing, Form and Details
//
// Collapsing those into one flag would change what reaches Firestore on a step advance.
// Each flag therefore records one call site's real scope. Whether the asymmetry is
// intentional is a separate question — see the audit; it is not decided here.

import type { WizardStep } from './types'

/** Which wizard an organizer is in. Determined by campaign type, not by the user. */
export type WizardFlow = 'standard' | 'fundraising' | 'campaign'

/** The draft document field a step writes. `null` ⇒ the step persists nothing of its own. */
export type DraftKey =
  | 'step0'
  | 'visibility'
  | 'accessControl'
  | 'pricing'
  | 'registrationForm'
  | 'eventDetails'
  | 'linkedCampaign'
  | 'licenseTier'

export interface StepDefinition {
  /** Stable identifier. Never an index — that is the whole point of this file. */
  id: string
  /** Position within its flow. Derived, never authored. */
  order: number
  /** Label shown in the Stepper. Must match the existing constants exactly. */
  title: string
  /** Draft field this step maps to, or null when it writes nothing. */
  draftKey: DraftKey | null
  /** Persisted by `goNext` when advancing off this step. */
  persistOnNext: boolean
  /** Persisted by an explicit "Save Draft" on this step. */
  persistOnSaveDraft: boolean
  /** Debounced within-step autosave is wired for this step. */
  autosaveOnEdit: boolean
  /** The step contributes a publish requirement. Informational; publish gating stays in
   *  `lib/events/validatePublish.ts`, which remains the single authority. */
  publishRequired: boolean
}

type StepSpec = Omit<StepDefinition, 'order'>

const define = (specs: StepSpec[]): StepDefinition[] =>
  specs.map((s, order) => ({ ...s, order }))

/** Drops the derived index so a step can be reused in another flow at a new position. */
const stripOrder = ({ order, ...spec }: StepDefinition): StepSpec => { void order; return spec }

// ─── standard ─────────────────────────────────────────────────────────────────
const STANDARD = define([
  { id: 'eventType',   title: 'Event Type',       draftKey: 'step0',            persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: true  },
  { id: 'visibility',  title: 'Visibility',       draftKey: 'visibility',       persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: true  },
  { id: 'access',      title: 'Access Control',   draftKey: 'accessControl',    persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: false },
  { id: 'pricing',     title: 'Passes & Pricing', draftKey: 'pricing',          persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: true,  publishRequired: true  },
  { id: 'form',        title: 'Form',             draftKey: 'registrationForm', persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: true,  publishRequired: true  },
  { id: 'details',     title: 'Details',          draftKey: 'eventDetails',     persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: true,  publishRequired: true  },
  // goNext does NOT persist these two today. Recorded, not corrected.
  { id: 'license',     title: 'License',          draftKey: 'licenseTier',      persistOnNext: false, persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: true  },
  { id: 'review',      title: 'Review',           draftKey: 'pricing',          persistOnNext: false, persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: false },
])

// ─── fundraising · 'Fundraising' inserted after Details ───────────────────────
const FUNDRAISING = define([
  // Reuse the first six standard steps verbatim; `define` re-derives order.
  ...STANDARD.slice(0, 6).map(stripOrder),
  { id: 'fundraising', title: 'Fundraising',      draftKey: 'linkedCampaign',   persistOnNext: true,  persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: true  },
  { id: 'license',     title: 'License',          draftKey: 'licenseTier',      persistOnNext: false, persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: true  },
  { id: 'review',      title: 'Review',           draftKey: 'pricing',          persistOnNext: false, persistOnSaveDraft: true,  autosaveOnEdit: false, publishRequired: false },
])

// ─── campaign · donation-only, replaces the wizard entirely ───────────────────
const CAMPAIGN = define([
  { id: 'visibility',  title: 'Visibility',        draftKey: 'visibility', persistOnNext: true, persistOnSaveDraft: true, autosaveOnEdit: false, publishRequired: true  },
  { id: 'details',     title: 'Campaign Details',  draftKey: 'step0',      persistOnNext: true, persistOnSaveDraft: true, autosaveOnEdit: false, publishRequired: true  },
  { id: 'donation',    title: 'Donation Settings', draftKey: 'step0',      persistOnNext: true, persistOnSaveDraft: true, autosaveOnEdit: false, publishRequired: true  },
  { id: 'review',      title: 'Review',            draftKey: null,         persistOnNext: false, persistOnSaveDraft: false, autosaveOnEdit: false, publishRequired: false },
])

export const STEP_REGISTRY: Record<WizardFlow, readonly StepDefinition[]> = {
  standard:    STANDARD,
  fundraising: FUNDRAISING,
  campaign:    CAMPAIGN,
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

export function stepsFor(flow: WizardFlow): readonly StepDefinition[] {
  return STEP_REGISTRY[flow]
}

/** The step at an index, or null when the index is out of range. */
export function stepAt(flow: WizardFlow, index: number): StepDefinition | null {
  return STEP_REGISTRY[flow][index] ?? null
}

/** Index of a step by id, or -1. Lets callers navigate by MEANING rather than number. */
export function indexOfStep(flow: WizardFlow, id: string): number {
  return STEP_REGISTRY[flow].findIndex(s => s.id === id)
}

/**
 * The draft field a step writes, for one call site.
 *
 * Returns null when that call site does not persist this step — which is how the three
 * asymmetric scopes are expressed without any of them hard-coding an index.
 */
export function draftKeyFor(
  flow: WizardFlow,
  index: number,
  site: 'next' | 'saveDraft' | 'autosave',
): DraftKey | null {
  const step = stepAt(flow, index)
  if (!step || !step.draftKey) return null
  const allowed =
    site === 'next'      ? step.persistOnNext
    : site === 'saveDraft' ? step.persistOnSaveDraft
    : step.autosaveOnEdit
  return allowed ? step.draftKey : null
}

/** Titles in order — the shape the existing `Stepper` consumes. */
export function wizardStepsFor(flow: WizardFlow): WizardStep[] {
  return STEP_REGISTRY[flow].map(s => ({ name: s.title }))
}
