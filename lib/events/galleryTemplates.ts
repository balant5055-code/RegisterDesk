// RD-MEDIA-02 · Gallery templates — THE single source of event-specific gallery names.
//
// PURE. No SDK, no React, no I/O.
//
// ─── Why this lives in lib/events/ ───────────────────────────────────────────
// Right beside `templateRegistry.ts`, whose ids it is keyed by. Two alternatives were
// rejected:
//   • a new `features/event-templates/` would sit confusingly beside the EXISTING
//     `components/event-templates/`, which means something entirely different (the public
//     event-page renderers).
//   • putting it in Media Studio would be the bug this change exists to fix.
// `lib/events/` is already the shared event-configuration home (templateRegistry, eventTabs,
// listingTabs), so a second consumer — print assets, say — finds it where it expects to.
//
// ─── No new enum ─────────────────────────────────────────────────────────────
// Templates are keyed by the EXISTING `TEMPLATE_REGISTRY` ids
// (community · conference · sports · workshop · exhibition · cultural · awards) and refined
// by the EXISTING `eventSubtype` values from `components/wizard/passSubtypeConfig.ts`.
// Nothing here invents an event taxonomy.
//
// ─── Media Studio knows none of this ─────────────────────────────────────────
// Media Studio calls `resolveGalleryTemplate(eventType, eventSubtype)` and renders whatever
// comes back. It contains no event name, and no `if (eventType === 'sports')`.

export interface GallerySuggestion {
  /**
   * Stable key, persisted on the gallery document as `preset`.
   *
   * BACKWARD COMPATIBILITY: the sports keys below are byte-identical to the ones Media
   * Studio hardcoded before this change, so galleries already created by an organizer keep
   * matching their suggestion and are never offered twice. Never rename an existing key —
   * add a new one instead.
   */
  key:   string
  name:  string
  /** Sort weight. Race distances read in course order, not alphabetically. */
  order: number
}

export interface GalleryTemplate {
  /** Diagnostic id — which template resolved. Not persisted. */
  id:          string
  label:       string
  suggestions: readonly GallerySuggestion[]
}

const s = (key: string, name: string, order: number): GallerySuggestion => ({ key, name, order })

// ─── Templates ────────────────────────────────────────────────────────────────

/**
 * Road running. The DEFAULT for `sports`, and the set Media Studio shipped with — its keys
 * are unchanged so existing marathon galleries behave exactly as before.
 */
const MARATHON: GalleryTemplate = {
  id: 'marathon', label: 'Marathon / Road Race',
  suggestions: [
    s('start-line',     'Start Line',      5),
    s('finish-line',    'Finish Line',    10),
    s('5km',            '5 KM',           20),
    s('10km',           '10 KM',          30),
    s('21km',           '21 KM',          40),
    s('42km',           '42 KM',          50),
    s('medal-ceremony', 'Medal Ceremony', 60),
    s('expo',           'Expo',           70),
    s('vip',            'VIP',            80),
  ],
}

const TOURNAMENT: GalleryTemplate = {
  id: 'tournament', label: 'Tournament',
  suggestions: [
    s('opening-ceremony',   'Opening Ceremony',   10),
    s('match',              'Match',              20),
    s('semi-final',         'Semi Final',         30),
    s('final',              'Final',              40),
    s('prize-distribution', 'Prize Distribution', 50),
    s('crowd',              'Crowd',              60),
    s('vip',                'VIP',                70),
  ],
}

const CONFERENCE: GalleryTemplate = {
  id: 'conference', label: 'Conference',
  suggestions: [
    s('registration',     'Registration',      10),
    s('opening-ceremony', 'Opening Ceremony',  20),
    s('keynote',          'Keynote',           30),
    s('sessions',         'Sessions',          40),
    s('panel-discussion', 'Panel Discussion',  50),
    s('networking',       'Networking',        60),
    s('sponsors',         'Sponsors',          70),
    s('awards',           'Awards',            80),
  ],
}

/** `corporate` is an EXISTING conference subtype, not a new event type. */
const CORPORATE: GalleryTemplate = {
  id: 'corporate', label: 'Corporate Event',
  suggestions: [
    s('registration', 'Registration', 10),
    s('welcome',      'Welcome',      20),
    s('sessions',     'Sessions',     30),
    s('workshop',     'Workshop',     40),
    s('networking',   'Networking',   50),
    s('awards',       'Awards',       60),
    s('group-photo',  'Group Photo',  70),
  ],
}

const MUSIC_FESTIVAL: GalleryTemplate = {
  id: 'music-festival', label: 'Music Festival',
  suggestions: [
    s('main-stage', 'Main Stage', 10),
    s('artists',    'Artists',    20),
    s('audience',   'Audience',   30),
    s('backstage',  'Backstage',  40),
    s('sponsors',   'Sponsors',   50),
    s('food-court', 'Food Court', 60),
  ],
}

const WORKSHOP: GalleryTemplate = {
  id: 'workshop', label: 'Workshop / Training',
  suggestions: [
    s('registration', 'Registration', 10),
    s('training',     'Training',     20),
    s('practical',    'Practical',    30),
    s('qa',           'Q&A',          40),
    s('certificates', 'Certificates', 50),
    s('group-photo',  'Group Photo',  60),
  ],
}

const NGO: GalleryTemplate = {
  id: 'ngo', label: 'Community / NGO',
  suggestions: [
    s('registration',      'Registration',      10),
    s('activities',        'Activities',        20),
    s('volunteers',        'Volunteers',        30),
    s('beneficiaries',     'Beneficiaries',     40),
    s('sponsors',          'Sponsors',          50),
    s('closing-ceremony',  'Closing Ceremony',  60),
  ],
}

const EXHIBITION: GalleryTemplate = {
  id: 'exhibition', label: 'Exhibition / Expo',
  suggestions: [
    s('registration',   'Registration',    10),
    s('stalls',         'Stalls',          20),
    s('exhibitors',     'Exhibitors',      30),
    s('visitors',       'Visitors',        40),
    s('product-launch', 'Product Launch',  50),
    s('sponsors',       'Sponsors',        60),
  ],
}

const AWARDS: GalleryTemplate = {
  id: 'awards', label: 'Awards Ceremony',
  suggestions: [
    s('red-carpet',       'Red Carpet',       10),
    s('registration',     'Registration',     20),
    s('ceremony',         'Ceremony',         30),
    s('winners',          'Winners',          40),
    s('audience',         'Audience',         50),
    s('sponsors',         'Sponsors',         60),
    s('after-party',      'After Party',      70),
  ],
}

/** Used when the event has no recognised type — never an empty list. */
const GENERIC: GalleryTemplate = {
  id: 'generic', label: 'General Event',
  suggestions: [
    s('registration',   'Registration',    10),
    s('highlights',     'Highlights',      20),
    s('attendees',      'Attendees',       30),
    s('sponsors',       'Sponsors',        40),
    s('closing',        'Closing',         50),
  ],
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/** Default per EXISTING `TEMPLATE_REGISTRY` id. */
const BY_EVENT_TYPE: Readonly<Record<string, GalleryTemplate>> = {
  sports:     MARATHON,
  conference: CONFERENCE,
  workshop:   WORKSHOP,
  community:  NGO,
  cultural:   MUSIC_FESTIVAL,
  exhibition: EXHIBITION,
  awards:     AWARDS,
}

/**
 * Subtype refinements, keyed `{eventType}:{eventSubtype}`.
 *
 * Subtype values are the EXISTING ones from `components/wizard/passSubtypeConfig.ts`. Only
 * subtypes that genuinely change the gallery set appear here; everything else falls through
 * to its type default, which is why this table is short rather than exhaustive.
 */
const BY_SUBTYPE: Readonly<Record<string, GalleryTemplate>> = {
  // Court and field sports are contested in rounds, not distances.
  'sports:cricket':    TOURNAMENT,
  'sports:football':   TOURNAMENT,
  'sports:hockey':     TOURNAMENT,
  'sports:tennis':     TOURNAMENT,
  'sports:badminton':  TOURNAMENT,
  'sports:basketball': TOURNAMENT,
  'sports:volleyball': TOURNAMENT,
  // Distance sports keep the marathon set (running, cycling, swimming, triathlon).
  'conference:corporate': CORPORATE,
}

/**
 * The template for an event.
 *
 * Falls back type default → GENERIC, so a caller always receives a usable list. Suggestions
 * come back sorted, so a consumer never sorts them itself.
 */
export function resolveGalleryTemplate(
  eventType: string | null | undefined,
  eventSubtype?: string | null,
): GalleryTemplate {
  const type = (eventType ?? '').trim().toLowerCase()
  const sub  = (eventSubtype ?? '').trim().toLowerCase()

  const refined = sub ? BY_SUBTYPE[`${type}:${sub}`] : undefined
  const template = refined ?? BY_EVENT_TYPE[type] ?? GENERIC

  return {
    ...template,
    suggestions: [...template.suggestions].sort((a, b) => a.order - b.order),
  }
}

/** Every template, for tests and tooling. */
export const ALL_GALLERY_TEMPLATES: readonly GalleryTemplate[] = [
  MARATHON, TOURNAMENT, CONFERENCE, CORPORATE, MUSIC_FESTIVAL,
  WORKSHOP, NGO, EXHIBITION, AWARDS, GENERIC,
]

/**
 * Display name for a suggestion key, searched across EVERY template.
 *
 * Deliberately global: a gallery created under one event type must still resolve its label
 * when read back, and an organizer may rename an event's type after creating galleries.
 * Returns null for an unknown key — a caller decides the fallback rather than being handed
 * a guess.
 */
export function suggestionName(key: string): string | null {
  for (const template of ALL_GALLERY_TEMPLATES) {
    const hit = template.suggestions.find(sug => sug.key === key)
    if (hit) return hit.name
  }
  return null
}

/** The marker for an organizer-named gallery. Never appears in a template. */
export const CUSTOM_GALLERY_KEY = 'custom'

/**
 * Whether a value is safe to persist as a gallery `preset`.
 *
 * A SHAPE check, not a membership check: the valid set now depends on the event, and a
 * gallery created under one template must remain valid if the template later changes. Bounded
 * and slug-shaped, so nothing hostile reaches Firestore.
 */
export function isSafeGalleryKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 40
    && /^[a-z0-9][a-z0-9-]*$/.test(value)
}
