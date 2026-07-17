// PA-8 — Professional Template Collections. PURE (client + server safe, no Firebase).
//
// Bundled, read-only starter designs. There is NO marketplace / download / purchase /
// sharing / rating. On import each collection template becomes an ORDINARY printTemplate
// (createPrintTemplate + savePrintDesign) — no second storage model, no schema change.
//
// Designs are assembled by small archetype factories so ~50 professional starters stay
// consistent and maintainable. Every design uses ONLY the existing element types and
// PA-5 variable tokens ({{name}} {{event}} {{pass}} {{category}} {{company}} {{ticket}}
// {{qr}} {{logo}}), so they render + edit like any hand-built template.

import { PRINT_DESIGN_VERSION } from './types'
import type {
  PrintCanvas, PrintDesign, PrintElement, PrintElementType,
  PrintElementProperties, PrintAssetType,
} from './types'

export type CollectionCategory =
  | 'sports' | 'conference' | 'corporate' | 'ngo' | 'expo' | 'college' | 'festival' | 'custom'

export interface CollectionTemplate {
  name:      string
  assetType: PrintAssetType
  canvas:    PrintCanvas
  design:    PrintDesign
}

export interface PrintCollection {
  id:           string
  name:         string
  description:  string
  category:     CollectionCategory
  accent:       string          // brand color for the (gradient) cover
  recommendFor: string[]        // event-type / campaign-type keywords
  templates:    CollectionTemplate[]
}

// ─── Canvas presets ─────────────────────────────────────────────────────────────
const CANVAS = {
  badge: { preset: 'CR80', width: 54,  height: 85.6, unit: 'mm', orientation: 'portrait'  } as PrintCanvas,
  passL: { preset: 'CR80', width: 54,  height: 85.6, unit: 'mm', orientation: 'portrait'  } as PrintCanvas,
  bib:   { preset: 'A5',   width: 148, height: 210,  unit: 'mm', orientation: 'portrait'  } as PrintCanvas,
  tent:  { preset: 'A5',   width: 148, height: 210,  unit: 'mm', orientation: 'landscape' } as PrintCanvas,
  card:  { preset: 'A6',   width: 105, height: 148,  unit: 'mm', orientation: 'portrait'  } as PrintCanvas,
  label: { preset: 'CUSTOM', width: 100, height: 60, unit: 'mm', orientation: 'landscape' } as PrintCanvas,
  tag:   { preset: 'CUSTOM', width: 60,  height: 110, unit: 'mm', orientation: 'portrait' } as PrintCanvas,
}

// ─── Element builders ───────────────────────────────────────────────────────────
function base(z: number): Omit<PrintElement, 'type' | 'properties'> {
  return { id: `e${z}`, x: 0.1, y: 0.1, width: 0.8, height: 0.1, rotation: 0, visible: true, locked: false, zIndex: z }
}
function elem(z: number, type: PrintElementType, box: Partial<Pick<PrintElement, 'x' | 'y' | 'width' | 'height'>>, properties: PrintElementProperties): PrintElement {
  return { ...base(z), type, ...box, properties }
}

interface Ctx { z: number; els: PrintElement[] }
const push = (c: Ctx, e: (z: number) => PrintElement) => { c.els.push(e(c.z)); c.z++ }

function text(box: Partial<PrintElement>, t: string, o: Partial<PrintElementProperties> = {}) {
  return (z: number) => elem(z, 'text', box, { text: t, fontSize: 0.05, fontWeight: 'normal', align: 'center', color: '#111827', opacity: 1, ...o })
}
function rect(box: Partial<PrintElement>, fill: string, o: Partial<PrintElementProperties> = {}) {
  return (z: number) => elem(z, 'rect', box, { fill, borderWidth: 0, radius: 0, opacity: 1, ...o })
}
function qr(box: Partial<PrintElement>, color = '#000000') {
  return (z: number) => elem(z, 'qr', box, { text: '{{qr}}', color, opacity: 1 })
}
function logo(box: Partial<PrintElement>) {
  return (z: number) => elem(z, 'image', box, { text: '{{logo}}', fit: 'contain', opacity: 1 })
}
function line(box: Partial<PrintElement>, color: string, thickness = 0.004) {
  return (z: number) => elem(z, 'line', box, { orientation: 'horizontal', thickness, color, opacity: 1 })
}

const design = (settings: Partial<PrintDesign['canvas']>, els: PrintElement[]): PrintDesign => ({
  version: PRINT_DESIGN_VERSION,
  canvas: { background: '#ffffff', borderColor: '#e5e7eb', borderWidth: 0, showGrid: true, snap: true, gridStep: 0.025, ...settings },
  elements: els,
})

// ─── Archetypes ─────────────────────────────────────────────────────────────────
function badge(name: string, assetType: PrintAssetType, role: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0, width: 1, height: 0.17 }, accent))
  push(c, text({ x: 0.05, y: 0.045, width: 0.9, height: 0.08 }, role, { color: '#ffffff', fontWeight: 'bold', fontSize: 0.05, letterSpacing: 0.08 }))
  push(c, logo({ x: 0.4, y: 0.2, width: 0.2, height: 0.1 }))
  push(c, text({ x: 0.05, y: 0.4, width: 0.9, height: 0.12 }, '{{name}}', { fontWeight: 'bold', fontSize: 0.075 }))
  push(c, text({ x: 0.05, y: 0.55, width: 0.9, height: 0.06 }, '{{pass}}', { fontSize: 0.042, color: accent, fontWeight: 'bold' }))
  push(c, qr({ x: 0.38, y: 0.66, width: 0.24, height: 0.17 }))
  push(c, text({ x: 0.05, y: 0.9, width: 0.9, height: 0.05 }, '{{event}}', { fontSize: 0.028, color: '#6b7280' }))
  return { name, assetType, canvas: CANVAS.badge, design: design({}, c.els) }
}

function pass(name: string, assetType: PrintAssetType, role: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0, width: 1, height: 1 }, accent))
  push(c, rect({ x: 0.06, y: 0.06, width: 0.88, height: 0.88 }, '#ffffff', { radius: 0.03 }))
  push(c, text({ x: 0.05, y: 0.12, width: 0.9, height: 0.09 }, role, { color: accent, fontWeight: 'bold', fontSize: 0.06, letterSpacing: 0.06 }))
  push(c, line({ x: 0.2, y: 0.24, width: 0.6, height: 0.004 }, accent, 0.004))
  push(c, text({ x: 0.05, y: 0.34, width: 0.9, height: 0.12 }, '{{name}}', { fontWeight: 'bold', fontSize: 0.072 }))
  push(c, text({ x: 0.05, y: 0.48, width: 0.9, height: 0.06 }, '{{pass}}', { fontSize: 0.04, color: '#6b7280' }))
  push(c, qr({ x: 0.37, y: 0.6, width: 0.26, height: 0.18 }))
  push(c, text({ x: 0.05, y: 0.86, width: 0.9, height: 0.05 }, '{{event}}', { fontSize: 0.03, color: '#6b7280' }))
  return { name, assetType, canvas: CANVAS.passL, design: design({}, c.els) }
}

function bib(name: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0, width: 1, height: 0.1 }, accent))
  push(c, rect({ x: 0, y: 0.9, width: 1, height: 0.1 }, accent))
  push(c, text({ x: 0.05, y: 0.03, width: 0.9, height: 0.05 }, '{{event}}', { color: '#ffffff', fontWeight: 'bold', fontSize: 0.032 }))
  push(c, text({ x: 0.05, y: 0.26, width: 0.9, height: 0.3 }, '{{bibNumber}}', { fontWeight: 'bold', fontSize: 0.26 }))
  push(c, text({ x: 0.05, y: 0.62, width: 0.9, height: 0.08 }, '{{name}}', { fontWeight: 'bold', fontSize: 0.055 }))
  push(c, text({ x: 0.05, y: 0.71, width: 0.9, height: 0.05 }, '{{category}}', { fontSize: 0.038, color: accent, fontWeight: 'bold' }))
  push(c, qr({ x: 0.42, y: 0.77, width: 0.16, height: 0.11 }))
  return { name, assetType: 'BIB', canvas: CANVAS.bib, design: design({}, c.els) }
}

function tent(name: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0.82, width: 1, height: 0.18 }, accent))
  push(c, text({ x: 0.05, y: 0.28, width: 0.9, height: 0.24 }, '{{name}}', { fontWeight: 'bold', fontSize: 0.17 }))
  push(c, text({ x: 0.05, y: 0.56, width: 0.9, height: 0.08 }, '{{company}}', { fontSize: 0.05, color: '#6b7280' }))
  push(c, text({ x: 0.05, y: 0.87, width: 0.9, height: 0.07 }, '{{event}}', { color: '#ffffff', fontSize: 0.04, fontWeight: 'bold' }))
  return { name, assetType: 'TABLE_TENT', canvas: CANVAS.tent, design: design({}, c.els) }
}

function card(name: string, assetType: PrintAssetType, role: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0, width: 1, height: 1 }, accent))
  push(c, rect({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, '#ffffff', { radius: 0.02 }))
  push(c, text({ x: 0.05, y: 0.14, width: 0.9, height: 0.1 }, role, { color: accent, fontWeight: 'bold', fontSize: 0.07, letterSpacing: 0.08 }))
  push(c, logo({ x: 0.42, y: 0.28, width: 0.16, height: 0.1 }))
  push(c, text({ x: 0.05, y: 0.44, width: 0.9, height: 0.12 }, '{{name}}', { fontWeight: 'bold', fontSize: 0.075 }))
  push(c, text({ x: 0.05, y: 0.58, width: 0.9, height: 0.06 }, '{{event}}', { fontSize: 0.038, color: '#6b7280' }))
  push(c, qr({ x: 0.38, y: 0.68, width: 0.24, height: 0.18 }))
  return { name, assetType, canvas: CANVAS.card, design: design({}, c.els) }
}

function label(name: string, role: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0, width: 0.32, height: 1 }, accent))
  push(c, text({ x: 0.02, y: 0.4, width: 0.28, height: 0.14 }, role, { color: '#ffffff', fontWeight: 'bold', fontSize: 0.1 }))
  push(c, text({ x: 0.36, y: 0.16, width: 0.44, height: 0.18 }, '{{name}}', { align: 'left', fontWeight: 'bold', fontSize: 0.14 }))
  push(c, text({ x: 0.36, y: 0.42, width: 0.44, height: 0.12 }, '{{pass}}', { align: 'left', fontSize: 0.09, color: accent }))
  push(c, text({ x: 0.36, y: 0.66, width: 0.44, height: 0.1 }, '{{event}}', { align: 'left', fontSize: 0.07, color: '#6b7280' }))
  push(c, qr({ x: 0.82, y: 0.28, width: 0.15, height: 0.44 }))
  return { name, assetType: 'CUSTOM', canvas: CANVAS.label, design: design({}, c.els) }
}

function tag(name: string, role: string, accent: string): CollectionTemplate {
  const c: Ctx = { z: 0, els: [] }
  push(c, rect({ x: 0, y: 0, width: 1, height: 0.14 }, accent))
  push(c, text({ x: 0.05, y: 0.04, width: 0.9, height: 0.06 }, role, { color: '#ffffff', fontWeight: 'bold', fontSize: 0.045, letterSpacing: 0.06 }))
  push(c, text({ x: 0.05, y: 0.24, width: 0.9, height: 0.1 }, '{{name}}', { fontWeight: 'bold', fontSize: 0.06 }))
  push(c, text({ x: 0.05, y: 0.38, width: 0.9, height: 0.06 }, '{{phone}}', { fontSize: 0.038, color: '#6b7280' }))
  push(c, text({ x: 0.05, y: 0.48, width: 0.9, height: 0.05 }, '{{event}}', { fontSize: 0.032, color: '#6b7280' }))
  push(c, qr({ x: 0.32, y: 0.6, width: 0.36, height: 0.22 }))
  return { name, assetType: 'CUSTOM', canvas: CANVAS.tag, design: design({}, c.els) }
}

// ─── The bundled collections ────────────────────────────────────────────────────
export const PRINT_COLLECTIONS: readonly PrintCollection[] = [
  {
    id: 'sports', name: 'Sports & Marathon', category: 'sports', accent: '#0ea5e9',
    description: 'Race bibs, runner badges and event passes for marathons and sporting events.',
    recommendFor: ['sports', 'marathon', 'run', 'race', 'cycling', 'triathlon'],
    templates: [
      bib('Race Bib Classic', '#111827'),
      bib('Race Bib Premium', '#b45309'),
      badge('Runner Badge', 'BADGE', 'RUNNER', '#0ea5e9'),
      badge('Volunteer Badge', 'VOLUNTEER', 'VOLUNTEER', '#16a34a'),
      badge('Medical Badge', 'BADGE', 'MEDICAL', '#dc2626'),
      pass('VIP Pass', 'VIP_PASS', 'VIP', '#7c3aed'),
      pass('Media Pass', 'MEDIA', 'MEDIA', '#0891b2'),
      pass('Parking Pass', 'PARKING', 'PARKING', '#475569'),
      label('Kit Label', 'RACE KIT', '#0ea5e9'),
      tag('Luggage Tag', 'BAGGAGE', '#475569'),
    ],
  },
  {
    id: 'conference', name: 'Conference', category: 'conference', accent: '#2563eb',
    description: 'Delegate, speaker and organizer badges plus table tents and booth passes.',
    recommendFor: ['conference', 'summit', 'meetup', 'seminar', 'workshop'],
    templates: [
      badge('Delegate Badge', 'BADGE', 'DELEGATE', '#2563eb'),
      badge('Speaker Badge', 'BADGE', 'SPEAKER', '#7c3aed'),
      badge('VIP Badge', 'VIP_PASS', 'VIP', '#b45309'),
      badge('Organizer Badge', 'BADGE', 'ORGANIZER', '#0f766e'),
      badge('Media Badge', 'MEDIA', 'MEDIA', '#0891b2'),
      tent('Table Tent', '#2563eb'),
      pass('Booth Pass', 'CUSTOM', 'BOOTH', '#475569'),
      pass('Parking Pass', 'PARKING', 'PARKING', '#475569'),
    ],
  },
  {
    id: 'corporate', name: 'Corporate', category: 'corporate', accent: '#0f766e',
    description: 'Visitor, employee and training passes for corporate events and offices.',
    recommendFor: ['corporate', 'training', 'business', 'company'],
    templates: [
      badge('Visitor Badge', 'BADGE', 'VISITOR', '#2563eb'),
      card('Employee Badge', 'ID_CARD', 'EMPLOYEE', '#0f766e'),
      pass('Training Pass', 'CUSTOM', 'TRAINING', '#7c3aed'),
      badge('VIP Badge', 'VIP_PASS', 'VIP', '#b45309'),
      pass('Parking Pass', 'PARKING', 'PARKING', '#475569'),
    ],
  },
  {
    id: 'ngo', name: 'NGO', category: 'ngo', accent: '#16a34a',
    description: 'Volunteer, staff and donor passes for fundraisers, camps and walkathons.',
    recommendFor: ['ngo', 'fundraiser', 'charity', 'walkathon', 'donation', 'nonprofit'],
    templates: [
      badge('Volunteer Badge', 'VOLUNTEER', 'VOLUNTEER', '#16a34a'),
      badge('Staff Badge', 'BADGE', 'STAFF', '#0f766e'),
      pass('Donor Pass', 'VIP_PASS', 'DONOR', '#b45309'),
      badge('Medical Camp Badge', 'BADGE', 'MEDICAL', '#dc2626'),
      bib('Walkathon Bib', '#16a34a'),
    ],
  },
  {
    id: 'college', name: 'College', category: 'college', accent: '#7c3aed',
    description: 'Participant, coordinator and judge badges plus winner cards for college fests.',
    recommendFor: ['college', 'cultural', 'fest', 'competition', 'university', 'campus'],
    templates: [
      badge('Participant Badge', 'BADGE', 'PARTICIPANT', '#2563eb'),
      badge('Coordinator Badge', 'BADGE', 'COORDINATOR', '#0f766e'),
      badge('Judge Badge', 'VIP_PASS', 'JUDGE', '#b45309'),
      badge('Volunteer Badge', 'VOLUNTEER', 'VOLUNTEER', '#16a34a'),
      card('Winner Card', 'ID_CARD', 'WINNER', '#b45309'),
    ],
  },
  {
    id: 'expo', name: 'Expo', category: 'expo', accent: '#0891b2',
    description: 'Visitor, exhibitor and booth passes for exhibitions and trade shows.',
    recommendFor: ['expo', 'exhibition', 'trade', 'fair'],
    templates: [
      badge('Visitor Badge', 'BADGE', 'VISITOR', '#2563eb'),
      badge('Exhibitor Badge', 'BADGE', 'EXHIBITOR', '#0f766e'),
      card('Booth Card', 'CUSTOM', 'BOOTH', '#475569'),
      badge('VIP Badge', 'VIP_PASS', 'VIP', '#b45309'),
      badge('Media Badge', 'MEDIA', 'MEDIA', '#0891b2'),
    ],
  },
  {
    id: 'festival', name: 'Festival', category: 'festival', accent: '#db2777',
    description: 'Artist, crew and volunteer passes for festivals and concerts.',
    recommendFor: ['festival', 'concert', 'music', 'carnival'],
    templates: [
      pass('Artist Pass', 'VIP_PASS', 'ARTIST', '#db2777'),
      pass('Crew Pass', 'CUSTOM', 'CREW', '#475569'),
      pass('Volunteer Pass', 'VOLUNTEER', 'VOLUNTEER', '#16a34a'),
      pass('VIP Pass', 'VIP_PASS', 'VIP', '#b45309'),
      pass('Parking Pass', 'PARKING', 'PARKING', '#475569'),
    ],
  },
  {
    id: 'custom', name: 'Custom Starters', category: 'custom', accent: '#475569',
    description: 'Neutral, general-purpose starters you can adapt to any event.',
    recommendFor: [],
    templates: [
      badge('Simple Badge', 'BADGE', 'BADGE', '#475569'),
      pass('Simple Pass', 'CUSTOM', 'PASS', '#475569'),
      bib('Simple Bib', '#475569'),
      tent('Name Tent', '#475569'),
      label('Kit Label', 'LABEL', '#475569'),
      tag('Luggage Tag', 'TAG', '#475569'),
    ],
  },
]

// ─── Accessors ──────────────────────────────────────────────────────────────────
export function getCollection(id: string): PrintCollection | undefined {
  return PRINT_COLLECTIONS.find(c => c.id === id)
}

/** Recommend a collection id for an event's type/campaign keywords, or null. */
export function recommendCollection(...hints: (string | null | undefined)[]): string | null {
  const hay = hints.filter(Boolean).map(h => String(h).toLowerCase())
  if (hay.length === 0) return null
  for (const col of PRINT_COLLECTIONS) {
    if (col.recommendFor.some(k => hay.some(h => h.includes(k) || k.includes(h)))) return col.id
  }
  return null
}
