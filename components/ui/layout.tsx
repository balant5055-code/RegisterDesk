// RD-RESPONSIVE-02 · Shared responsive layout primitives.
//
// ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════════
// RegisterDesk has a shared design system but had no shared LAYOUT system. Tokens govern
// colour, type and spacing INSIDE components; nothing governed the page skeleton BETWEEN
// them, so every page author re-derived the grid, the rhythm and the rail width.
//
// The RD-RESPONSIVE-01 audit measured the result across app/, components/ and features/:
//
//   • 62 two-column bracket grids, in 12+ distinct rail widths (256px … 420px)
//   • 50 of those 62 omit `minmax(0,…)` — the single most common cause of horizontal
//     overflow in CSS grid
//   • 9 different `space-y-*` values used as PAGE rhythm
//   • 72 of 79 `sticky` elements have no breakpoint prefix, so they are sticky on phones
//   • `items-start` present on 11 of 58 grids — inconsistently, and it is load-bearing
//
// These constants are the one answer to each. They are strings, not components: adopting
// them requires no rewrite, and a page that has not adopted them is unaffected.
//
// ═══ WHY STRINGS AND NOT INTERPOLATION ════════════════════════════════════════
// Tailwind v4 scans raw source TEXT for class candidates. It does not execute JavaScript, so
// a class whose track list is assembled at runtime from a variable is never seen by the
// compiler and never generates a rule. Every class below therefore appears as a complete
// literal. Compose them with `cn()`; never build one by interpolation.
//
// Note the shape of this very comment: it describes the hazard WITHOUT spelling an
// arbitrary-value class inside it. Tailwind does not parse comments — it extracts candidates
// from raw text — so an example written out here would itself be compiled, which is how an
// invalid rule reached the stylesheet once before.
//
// (This is not theoretical. A wildcard class spelled inside a COMMENT in this codebase was
// extracted as a real candidate and compiled to invalid CSS, which failed the build.)

/**
 * The page rhythm: the vertical gap between top-level sections of a page.
 *
 * The audit found nine different values doing this job, three of them common
 * (`space-y-4` ×54, `space-y-5` ×41, `space-y-6` ×16). 16px is the tightest of the three and
 * reads as deliberate at every viewport; larger values push the primary action below the
 * fold on laptops without adding clarity.
 */
export const PAGE_STACK = 'space-y-4'

// ─── Rail widths ──────────────────────────────────────────────────────────────
//
// Three named sizes replace the ten ad-hoc widths the audit found. Each is a COMPLETE class,
// for the reason given above.
//
// ═══ WHY `minmax(0,1fr)` AND NEVER A BARE `1fr` ═══════════════════════════════
// A grid track sized `1fr` resolves to `minmax(auto, 1fr)`. The `auto` MINIMUM means the
// track can never be smaller than its content's min-content size — so a single unbreakable
// child (a long filename, a wide table, a `whitespace-nowrap` chip row) pushes the track,
// and therefore the whole grid, wider than its container. The page then scrolls sideways.
//
// `minmax(0,1fr)` sets that minimum to zero, so the track may shrink below its content and
// the overflow is contained by the child instead of escaping to the document. This is why
// 50 of the app's 62 grids are latent horizontal-overflow bugs and 12 are not.

/** Compact rail — filters, short summaries. */
export const RAIL_WIDTH_SM = 'lg:grid-cols-[minmax(0,1fr)_280px]'
/** Default rail — metrics, status, a primary action. The Media Studio size. */
export const RAIL_WIDTH_MD = 'lg:grid-cols-[minmax(0,1fr)_320px]'
/** Wide rail — dense tables of facts, or a rail that carries its own controls. */
export const RAIL_WIDTH_LG = 'lg:grid-cols-[minmax(0,1fr)_380px]'

/**
 * The two-pane workspace: content beside a rail.
 *
 * One column below `lg`, two at and above it — the rail moves BELOW the content on tablet
 * and mobile rather than being squeezed. Defaults to the 320px rail; override by composing
 * with `RAIL_WIDTH_SM` or `RAIL_WIDTH_LG`:
 *
 *   cn(WORKSPACE_GRID, RAIL_WIDTH_LG)
 *
 * Note what is deliberately ABSENT: `items-start`. Grid items default to `stretch`, which is
 * what gives a sticky rail room to travel — see `RAIL_COLUMN`.
 */
export const WORKSPACE_GRID = `grid grid-cols-1 gap-4 ${RAIL_WIDTH_MD}`

/**
 * The main content column of a workspace grid.
 *
 * ═══ WHY `min-w-0` ═══════════════════════════════════════════════════════════
 * A flex or grid child also defaults to `min-width: auto`, for the same reason the track
 * does. Without `min-w-0`, a child that cannot shrink — most often a `truncate` element,
 * which needs a bounded parent before it will ever truncate — forces the column wider than
 * its share and pushes the rail off-screen.
 *
 * `min-w-0` is what makes `truncate`, `overflow-x-auto` and long unbroken strings behave
 * inside a grid. It is required on BOTH columns, which is why `RAIL_COLUMN` carries it too.
 */
export const CONTENT_COLUMN = 'min-w-0'

/**
 * The rail column of a workspace grid.
 *
 * ═══ WHY `lg:sticky` ON THE COLUMN, NOT ON THE CARD INSIDE IT ════════════════
 * For a GRID ITEM, `position: sticky` resolves against the grid CONTAINER, not against the
 * item. So a sticky grid item travels the full height of the grid — which the content column
 * drives — while occupying only its own height in layout.
 *
 * Putting sticky on a card INSIDE the item does not work: that card's containing block is
 * the item, and a content-sized item leaves zero travel room. RegisterDesk shipped an inert
 * sticky rail for a full sprint that way.
 *
 * ═══ WHY `lg:self-start` ═════════════════════════════════════════════════════
 * Grid items default to `align-items: stretch`, so a short rail is inflated to the tall
 * column's height — a box of empty space below the rail's content, and a page that appears
 * to have unexplained height. `self-start` sizes the item to its content instead.
 *
 * The two are a pair. `self-start` alone would break sticky if sticky were on the inner card;
 * it is safe here precisely because sticky is on the item and resolves against the container.
 *
 * ═══ WHY STICKY IS DESKTOP-ONLY ══════════════════════════════════════════════
 * Below `lg` the grid is a single column and the rail sits BELOW the content. A sticky
 * element there would pin a summary panel over a phone's already-scarce viewport while the
 * user is trying to read what it summarises. The audit found 72 of 79 sticky elements in the
 * app with no breakpoint prefix — sticky on phones by accident, not by decision.
 */
export const RAIL_COLUMN = 'min-w-0 lg:sticky lg:top-6 lg:self-start'
