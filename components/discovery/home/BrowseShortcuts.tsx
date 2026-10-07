// ─── Browse — the category index beneath the search bar ─────────────────────
//
// A SERVER component, zero client JavaScript: each entry is a plain <Link> to a real,
// crawlable, shareable URL.
//
// ═══ AN INDEX, NOT A CHIP ROW ════════════════════════════════════════════════
// This used to be seven grey stadium pills. Two problems, and they compounded: a pill draws a
// container around a word that needs no container, and seven of them wrapped to three rows on
// a phone — roughly 100px of decoration above the first real event.
//
// The treatment is editorial instead. An overline, a hairline that runs to the edge of the
// container, then the categories set as plain type on one line, with the accent appearing only
// under the word being hovered. Nothing is boxed, so nothing competes with the search bar
// above it or the event cards below it, and the whole block is a little over 50px tall.
//
// ═══ ONE BAND AT EVERY WIDTH ═════════════════════════════════════════════════
// The row scrolls horizontally rather than wrapping, and bleeds to the viewport edge on the
// way (the negative margins undo the container's gutter, the padding puts it back inside the
// scroller) so a partially visible next word is the affordance that says there is more. That
// is what keeps this one compact band at 320px instead of three stacked rows.
//
// Keyboard users are not asked to swipe: these are ordinary links in source order, and a
// browser scrolls a focused link into view by itself.
//
// ═══ WHY THESE EXACT ENTRIES ═════════════════════════════════════════════════
// They are the real DISCOVERY_CATEGORIES ids — the values an event document can actually
// hold. A shortcut filtering on anything else returns an empty page, which is the defect
// discoveryTaxonomy.ts records having shipped once before. All ten are listed now rather than
// the first seven: a scrolling band has room for the whole index, and truncating it hid four
// genuine categories for no reason once wrapping was no longer the constraint.
//
// ═══ 2026-09-23 · THE CATEGORY RAIL (owner: "beautify this section") ═════════
// Each category is now an icon over its label: a small bronze-outlined tile (the
// --radius-control square, never a pill) carrying the SAME CATEGORY_ICON the event cards'
// type chip uses, so a category looks identical wherever it appears. The heading took the
// public site's editorial voice — bronze rule, widely tracked small caps. Hover is still the
// action-colour underline under the WORD, plus the tile warming to --action.
//
// ═══ ONE ROW, AS A SLIDER — AND THE OVERFLOW IS ANNOUNCED (owner, same day) ═══
// A silent sideways scroll is missed on a phone; a wrapped grid was rejected ("it should
// be in one row, like a slider"). BrowseRail (client) is the answer to both: one row that
// snaps per category, with a visible arrow button and a fade on whichever edge has more
// beyond it. Where all ten fit (lg), there is no arrow and no fade. The links stay here,
// server-rendered, and are handed to the rail as children.
//
// There is deliberately no "All Events" entry. It would resolve to `/` — the page the reader
// is already on — which is the same dead round trip that got the section's old "View all
// events" CTA removed. Clearing a filter is already offered, in context, by the "Clear all"
// control that appears beside the active filter chips.

import Link from 'next/link'
import { BrowseRail } from './BrowseRail'
import { CATEGORY_ICON, DISCOVERY_CATEGORIES, FALLBACK_CATEGORY_ICON } from '@/components/marketing/discovery/discoveryTaxonomy'
import { DEFAULT_URL_STATE, discoveryHref } from '@/lib/discovery/urlState'

export function BrowseShortcuts() {
  return (
    <nav aria-label="Browse events by category">
      {/* The overline and the rule are one line: a short bronze mark, the label, then a
          hairline that takes whatever width is left. */}
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
        <span className="text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
          Browse by category
        </span>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>

      <BrowseRail>
        {DISCOVERY_CATEGORIES.map(c => {
          const Icon = CATEGORY_ICON[c.id] ?? FALLBACK_CATEGORY_ICON
          return (
            <li key={c.id} className="shrink-0 snap-start">
              <Link
                href={discoveryHref({ ...DEFAULT_URL_STATE, category: c.id })}
                className={[
                  'group flex min-w-[5rem] flex-col items-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] px-1.5 py-1',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
                ].join(' ')}
              >
                <span
                  aria-hidden
                  className={[
                    'inline-flex size-11 items-center justify-center rounded-[var(--radius-control)]',
                    'border border-hero-accent-rule/35 bg-card text-hero-accent-rule',
                    'transition-colors duration-200 ease-out',
                    'group-hover:border-action/40 group-hover:bg-action/[0.04] group-hover:text-action',
                  ].join(' ')}
                >
                  <Icon className="size-[18px]" strokeWidth={1.5} />
                </span>
                <span
                  className={[
                    'text-fs-xs font-medium text-hero-ink-soft',
                    'underline-offset-[6px] decoration-2 decoration-action/70',
                    'transition-colors group-hover:text-hero-ink group-hover:underline',
                  ].join(' ')}
                >
                  {c.label}
                </span>
              </Link>
            </li>
          )
        })}
      </BrowseRail>
    </nav>
  )
}
