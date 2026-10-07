'use client'

// ─── The search bar: Search · Category · Location · Date · Go ────────────────
//
// The ONLY client island in the hero. Everything around it — eyebrow, headline, collage,
// browse row — is server-rendered, so the landing page ships interactivity for this control
// and nothing else.
//
// It owns no filtering logic. It reads and writes DiscoveryUrlState through the pure
// lib/discovery/urlState module, so a search is shareable, bookmarkable and restorable with
// the Back button — the defect the staging /events page still has, where filters live in
// useState alone and a reload silently discards them.
//
// ═══ ONE BAR, NOT FOUR BOXES ═════════════════════════════════════════════════
// This used to draw every control as its own bordered 52px field inside a bordered capsule:
// five equal-weight boxes in a row, which is the shape of a form rather than of a product
// control. Nothing said which one to use first.
//
// Now the CONTAINER is the bordered object and the controls live inside it. The query field
// is the only one with a background and the widest track; the three filters are transparent
// until hovered, separated from the query by one hairline; the CTA is the single gradient
// element. Same four controls, same order, one clear hierarchy — and 52px controls became
// 44px, which is what the section actually needed.
//
// ═══ MOBILE IS ITS OWN COMPOSITION, NOT THE DESKTOP BAR STACKED ══════════════
// Stacking gave five 52px rows plus gaps — a ~292px block before a single event was visible.
// The phone layout is deliberately different: the query keeps a full row with the submit
// button inline beside it, and the three filters share ONE row beneath as equal thirds. Two
// rows, ~100px, and the filters stay a glance rather than a checklist.
//
// The filter icons are hidden below `sm` for a measured reason: at 320px each third is 88px,
// and an icon plus a chevron leaves ~28px for the label — every value would truncate. The
// chevron is kept instead, because it is what says "this opens".
//
// ═══ WHY THE URL IS READ HERE AND NOT ON THE SERVER ══════════════════════════
// `searchParams` is a Request-time API: a page that reads it is opted into DYNAMIC rendering
// for every request. Reading it in the page turned `/` from a prerendered, 60s-revalidated
// route into one that re-queried Firestore on every visit to the site's highest-traffic URL —
// measured, not assumed: the build's route table reported `ƒ /` instead of `○ /`. Reading it
// here keeps `/` static.
//
// ═══ WHY THE FORM IS KEYED ═══════════════════════════════════════════════════
// Back/Forward and chip removal are navigations on the SAME route, so this component
// re-renders rather than remounting and `useState` would keep showing the previous search.
// Keying the form on the serialised query remounts it with freshly seeded inputs. The obvious
// alternative — an effect that setStates when the URL changes — is a cascading render, and
// the React Compiler rejects it outright.

import { useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LayoutGrid, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { LocationPicker } from '@/components/marketing/discovery/LocationPicker'
import type { LocationValue } from '@/components/marketing/discovery/LocationPicker'
import { DatePicker } from '@/components/marketing/discovery/DatePicker'
import type { DateValue } from '@/components/marketing/discovery/DatePicker'
import { DiscoveryPopover, PopoverRow, FieldTrigger } from '@/components/marketing/discovery/DiscoveryPopover'
import { DISCOVERY_CATEGORIES, categoryLabel } from '@/components/marketing/discovery/discoveryTaxonomy'
import { discoveryHref, nextUrlState, parseDiscoveryParams } from '@/lib/discovery/urlState'
import type { DiscoveryUrlState } from '@/lib/discovery/urlState'

export interface HomeSearchProps {
  /** Cities present in the loaded events, most first. Real data only — never a fixed list. */
  cityCounts:  { name: string; count: number }[]
  /** States present in the loaded events, most first. */
  stateCounts: { name: string; count: number }[]
}

/**
 * Reserves the bar's footprint so the Suspense fallback causes no layout shift.
 *
 * Phone  6px padding + 40px query row + 6px gap + 40px filter row + 6px + 2px border = 100px
 * sm+    6px padding + 44px control row + 6px + 2px border = 58px
 */
export const SEARCH_CAPSULE_MIN_H = 'min-h-[6.25rem] sm:min-h-[3.625rem]'

/** The single gradient element on the page. Named, never re-typed (globals.css). */
const CTA = cn(
  'cursor-pointer rd-brand-gradient text-action-foreground transition-opacity hover:opacity-90',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
)

export function HomeSearch({ cityCounts, stateCounts }: HomeSearchProps) {
  const params = useSearchParams()
  const qs = params.toString()

  return (
    <SearchForm
      key={qs}
      state={parseDiscoveryParams(new URLSearchParams(qs))}
      cityCounts={cityCounts}
      stateCounts={stateCounts}
    />
  )
}

/** The category control — real eventType ids only, on the shared popover primitive. */
function CategorySegment({
  value, onChange,
}: {
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <DiscoveryPopover
      open={open}
      onClose={() => setOpen(false)}
      title="Category"
      widthPx={260}
      className="min-w-0 sm:flex-1"
      trigger={a => (
        <FieldTrigger
          {...a}
          label="Category"
          value={value ? categoryLabel(value) : 'All Categories'}
          shortValue={value ? categoryLabel(value) : 'Category'}
          icon={<LayoutGrid className={cn('size-3.5', value ? 'text-action' : 'text-hero-accent-rule')} />}
          active={!!value}
          open={open}
          onClick={() => setOpen(o => !o)}
          className="w-full"
        />
      )}
    >
      <PopoverRow
        active={!value}
        onClick={() => { onChange(''); setOpen(false) }}
        label="All Categories"
      />
      {DISCOVERY_CATEGORIES.map(c => (
        <PopoverRow
          key={c.id}
          active={value === c.id}
          onClick={() => { onChange(c.id); setOpen(false) }}
          label={c.label}
        />
      ))}
    </DiscoveryPopover>
  )
}

function SearchForm({
  state, cityCounts, stateCounts,
}: HomeSearchProps & { state: DiscoveryUrlState }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState(state.query)
  const [category, setCategory] = useState(state.category)
  const [location, setLocation] = useState<LocationValue>({
    city: state.city, state: state.state, venue: state.venue,
  })
  const [date, setDate] = useState<DateValue>({ key: state.date, from: state.from, to: state.to })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    inputRef.current?.blur()
    router.push(discoveryHref(nextUrlState(state, {
      query: query.trim(),
      category,
      city: location.city, state: location.state, venue: location.venue,
      date: date.key, from: date.from, to: date.to,
    })))
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        // The bordered object is the BAR. Everything inside it is a part, not a peer.
        'flex w-full flex-col gap-1.5 rounded-xl border border-border/70 bg-card p-1.5',
        'shadow-elevation-1 transition-colors focus-within:border-action/40',
        'sm:flex-row sm:items-center sm:gap-1',
      )}
    >
      {/* ── The query: the one control with a fill, and the widest track ── */}
      <div className="flex min-w-0 items-center gap-1.5 sm:flex-[1.75] sm:gap-0">
        <label className={cn(
          'flex h-10 min-w-0 flex-1 cursor-text items-center gap-2.5 rounded-md bg-muted/40 px-3 sm:h-11',
          // The field's own focus indicator. The input carries `outline-none` so the browser's
          // default outline never draws inside the bar, which means this ring IS the indicator —
          // a background shift alone was too quiet to satisfy a visible-focus requirement.
          'transition-colors focus-within:bg-card focus-within:ring-2 focus-within:ring-action/35',
        )}>
          <Search className="size-[18px] shrink-0 text-hero-accent-rule" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col self-stretch justify-center">
          {/* The field's name above the input from sm, matching the filters' labels. */}
          <span aria-hidden className="hidden text-[0.625rem] font-semibold uppercase leading-none tracking-[0.18em] text-hero-eyebrow sm:block">
            Search
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search events, organizers or locations"
            aria-label="Search events, organizers or locations"
            autoComplete="off"
            maxLength={80}
            /* h-full, not the input's intrinsic 21px line box: the caret target should be the
               whole 40px row, not a strip through the middle of it. */
            className="h-full w-full min-w-0 bg-transparent text-fs-base text-foreground outline-none placeholder:text-muted-foreground sm:mt-1 sm:h-auto sm:text-fs-sm sm:leading-tight"
          />
          </span>
          {query && (
            /* A genuinely circular 24px icon button — the one shape here that is meant to be
               round, and small enough that a rectangle would read as a stray box. */
            <button
              type="button"
              onClick={() => { setQuery(''); inputRef.current?.focus() }}
              aria-label="Clear search"
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </label>

        {/* Phone submit: inline with the query so the primary action costs no extra row. */}
        <button
          type="submit"
          aria-label="Search events"
          className={cn(CTA, 'flex size-10 shrink-0 items-center justify-center rounded-md sm:hidden')}
        >
          <Search className="size-[18px]" aria-hidden />
        </button>
      </div>

      {/* One hairline, and only from `sm`: it separates the query from the filters, which is
          the only division in the bar that carries meaning. */}
      <span aria-hidden className="mx-1 hidden h-6 w-px shrink-0 bg-border/70 sm:block" />

      {/* ── The filters. One row of equal thirds on a phone; `sm:contents` dissolves this
             wrapper from `sm` so the three become flex items of the bar itself. ── */}
      <div className="grid min-w-0 grid-cols-3 gap-1 sm:contents">
        <CategorySegment value={category} onChange={setCategory} />

        {/* Hairlines between the filters too (sm+), so the bar reads as four answered
            questions rather than one field and three loose words. Hidden on a phone, where
            they would become grid items. */}
        <span aria-hidden className="hidden h-6 w-px shrink-0 bg-border/70 sm:block" />

        <LocationPicker
          variant="field"
          value={location}
          onChange={setLocation}
          cityCounts={cityCounts}
          stateCounts={stateCounts}
          className="min-w-0 sm:flex-1"
        />

        <span aria-hidden className="hidden h-6 w-px shrink-0 bg-border/70 sm:block" />

        <DatePicker
          variant="field"
          value={date}
          onChange={setDate}
          className="min-w-0 sm:flex-1"
        />
      </div>

      <button
        type="submit"
        className={cn(
          CTA,
          'hidden h-11 shrink-0 items-center justify-center rounded-lg px-5',
          'text-fs-base font-semibold sm:flex',
        )}
      >
        Search Events
      </button>
    </form>
  )
}

/**
 * The active filters, as removable chips beneath the bar.
 *
 * They used to be stadium-shaped. Nothing here is a badge or an avatar — they are controls,
 * and they now carry the same restrained radius as the bar's own parts.
 */
export function ActiveFilterChips() {
  const router = useRouter()
  const params = useSearchParams()
  const qs = params.toString()
  const state = parseDiscoveryParams(new URLSearchParams(qs))

  const chips: { key: string; label: string; patch: Partial<DiscoveryUrlState> }[] = []
  if (state.query)    chips.push({ key: 'q',   label: `“${state.query}”`,            patch: { query: '' } })
  if (state.category) chips.push({ key: 'cat', label: categoryLabel(state.category), patch: { category: '' } })
  if (state.city)     chips.push({ key: 'city', label: state.city,                   patch: { city: '' } })
  if (state.state)    chips.push({ key: 'st',  label: state.state,                   patch: { state: '' } })
  if (state.venue)    chips.push({ key: 'v',   label: state.venue,                   patch: { venue: null } })
  if (state.date)     chips.push({ key: 'd',   label: state.date,                    patch: { date: null, from: '', to: '' } })
  if (!chips.length) return null

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {chips.map(c => (
        <button
          key={c.key}
          type="button"
          onClick={() => router.push(discoveryHref(nextUrlState(state, c.patch)))}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-action/25 bg-action/[0.06] py-1 pl-2.5 pr-1.5 text-fs-sm font-medium text-action transition-colors hover:bg-action/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
        >
          {c.label}
          <X className="size-3.5" aria-hidden />
          <span className="sr-only">Remove filter</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => router.push('/')}
        className="ml-0.5 cursor-pointer rounded-md px-2 py-1 text-fs-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
      >
        Clear all
      </button>
    </div>
  )
}
