'use client'

// ─── Location picker ─────────────────────────────────────────────────────────
//
// Location is the first-class axis of RegisterDesk discovery: the product is India-wide, and
// the page has to make "anywhere in India" feel like one tap rather than a hidden dropdown.
//
// Everything selectable here maps onto a filter the API already runs over the WHOLE published
// set — `city`, `state`, or `venue` — so nothing in this panel is decorative.
//
//   All India   clears city + state + venue
//   Near me     browser geolocation → nearest city in the static table → `city=`
//   Online      `venue=online`      Hybrid → `venue=hybrid`
//   Cities      `city=`  — the list is DERIVED FROM LOADED EVENTS, never hardcoded, so a city
//               is only ever offered when events genuinely exist there
//   States      `state=` — grouped by region, which is what makes the national reach legible
//
// The state list is the static INDIA_REGIONS table, filtered to states that actually appear
// in the loaded events, plus (behind "show all") the full list, because the loaded page is one
// page of many and a state absent from it may still have events.

import { useMemo, useState } from 'react'
import {
  MapPin, Navigation, Globe, Blend, Check, Search, Loader2, ChevronRight, Building2,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { DiscoveryPopover, PopoverRow, PopoverGroupLabel, FieldTrigger } from './DiscoveryPopover'
import { INDIA_REGIONS, nearestCity } from './indiaGeo'
import type { VenueKey } from './discoveryTaxonomy'

export interface LocationValue {
  city:  string
  state: string
  venue: VenueKey | null
}

export const EMPTY_LOCATION: LocationValue = { city: '', state: '', venue: null }

/** The label the trigger shows — also reused by the active-filter chip strip. */
export function locationLabel(v: LocationValue): string {
  if (v.city)  return v.city
  if (v.state) return v.state
  if (v.venue === 'online') return 'Online'
  if (v.venue === 'hybrid') return 'Hybrid'
  if (v.venue === 'physical') return 'In person'
  return 'All India'
}

export function isLocationSet(v: LocationValue): boolean {
  return !!(v.city || v.state || v.venue)
}

type GeoState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'done'; city: string }
  | { kind: 'error'; message: string }

export function LocationPicker({
  value,
  onChange,
  /** Cities present in the loaded events, most events first. Real data only. */
  cityCounts,
  /** States present in the loaded events, most events first. Real data only. */
  stateCounts,
  className,
  variant = 'segment',
}: {
  value:       LocationValue
  onChange:    (v: LocationValue) => void
  cityCounts:  { name: string; count: number }[]
  stateCounts: { name: string; count: number }[]
  className?:  string
  /** `segment` = inside the hero capsule · `pill` = the sticky bar's compact control. */
  variant?:    'segment' | 'pill' | 'field'
}) {
  const [open, setOpen]     = useState(false)
  const [query, setQuery]   = useState('')
  const [allStates, setAll] = useState(false)
  const [geo, setGeo]       = useState<GeoState>({ kind: 'idle' })

  const active = isLocationSet(value)
  const label  = locationLabel(value)

  const pick = (patch: Partial<LocationValue>) => {
    onChange({ ...EMPTY_LOCATION, ...patch })
    setQuery('')
    setOpen(false)
  }

  // States worth offering: those seen in the loaded events (with a real count), then — behind
  // "Show every state" — the rest of India, so the panel never implies the platform stops at
  // whatever the current page happened to contain.
  const seenStates = useMemo(
    () => new Set(stateCounts.map(s => s.name.toLowerCase())),
    [stateCounts],
  )

  const regionGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return INDIA_REGIONS
      .map(r => ({
        name: r.name,
        states: r.states
          .filter(s => (allStates || seenStates.has(s.toLowerCase())))
          .filter(s => !q || s.toLowerCase().includes(q)),
      }))
      .filter(r => r.states.length > 0)
  }, [query, allStates, seenStates])

  const filteredCities = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cityCounts.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, q ? 12 : 8)
  }, [cityCounts, query])

  const locateMe = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeo({ kind: 'error', message: 'Your browser cannot share a location.' })
      return
    }
    setGeo({ kind: 'locating' })
    navigator.geolocation.getCurrentPosition(
      pos => {
        const hit = nearestCity(pos.coords.latitude, pos.coords.longitude)
        if (!hit) {
          setGeo({ kind: 'error', message: 'No RegisterDesk city near you yet — browse by state instead.' })
          return
        }
        setGeo({ kind: 'done', city: hit.city })
        pick({ city: hit.city })
      },
      err => {
        setGeo({
          kind: 'error',
          message: err.code === err.PERMISSION_DENIED
            ? 'Location access was blocked. Pick a city below instead.'
            : 'We could not read your location. Pick a city below instead.',
        })
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 600_000 },
    )
  }

  const showEverything = !query.trim()

  return (
    <DiscoveryPopover
      open={open}
      onClose={() => setOpen(false)}
      title="Where"
      widthPx={340}
      className={className}
      trigger={a => (
        variant === 'field' ? (
          <FieldTrigger
            {...a}
            label="Location"
            value={label}
            icon={<MapPin className={cn('size-3.5 shrink-0', active ? 'text-action' : 'text-hero-accent-rule')} />}
            active={active}
            open={open}
            onClick={() => setOpen(o => !o)}
            className="w-full"
          />
        ) : (
        <button
          {...a}
          type="button"
          onClick={() => setOpen(o => !o)}
          className={cn(
            'group flex w-full cursor-pointer items-center gap-2 text-left transition-colors',
            variant === 'segment'
              ? 'h-full min-w-0 px-3.5 py-2 hover:bg-muted/40'
              : cn(
                  'h-10 shrink-0 justify-center rounded-xl border px-2.5 text-[13px] font-semibold sm:justify-start sm:px-3',
                  active
                    ? 'border-action/40 bg-action/[0.06] text-action'
                    : 'border-border/70 bg-card text-foreground hover:border-border-strong hover:bg-muted/40',
                ),
          )}
        >
          <MapPin className={cn(
            'size-4 shrink-0',
            variant === 'segment'
              ? (active ? 'text-action' : 'text-muted-foreground/60')
              : '',
          )} />
          {variant === 'segment' ? (
            <span className="min-w-0 flex-1">
              <span className="block text-[10.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground/70">
                Where
              </span>
              <span className={cn(
                'block truncate text-[13.5px] font-semibold leading-tight',
                active ? 'text-foreground' : 'text-muted-foreground/70',
              )}>
                {label}
              </span>
            </span>
          ) : (
            <span className="hidden max-w-[7.5rem] truncate sm:inline">{label}</span>
          )}
        </button>
        )
      )}
    >
      {/* Search inside the panel — one field that narrows both cities and states */}
      <div className="sticky top-0 z-10 bg-card px-1.5 pb-2 pt-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-[15px] -translate-y-1/2 text-muted-foreground/45" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search city or state…"
            aria-label="Search city or state"
            className="h-9 w-full rounded-xl border border-border/70 bg-muted/25 pl-9 pr-3 text-[13px] text-foreground outline-none transition-all placeholder:text-muted-foreground/45 focus:border-action/40 focus:bg-card focus:ring-2 focus:ring-action/10"
          />
        </div>
      </div>

      {showEverything && (
        <>
          <PopoverRow
            active={!active}
            onClick={() => pick({})}
            icon={<Globe className="size-3.5" />}
            label="All India"
            hint="Every city, every state"
            trailing={!active ? <Check className="size-4 shrink-0 text-action" /> : undefined}
          />
          <PopoverRow
            active={geo.kind === 'locating'}
            onClick={locateMe}
            icon={geo.kind === 'locating'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <Navigation className="size-3.5" />}
            label={geo.kind === 'locating' ? 'Finding you…' : 'Near me'}
            hint={geo.kind === 'error' ? geo.message : 'Use my current location'}
          />

          <PopoverGroupLabel>Attend from anywhere</PopoverGroupLabel>
          <PopoverRow
            active={value.venue === 'online'}
            onClick={() => pick({ venue: 'online' })}
            icon={<Globe className="size-3.5" />}
            label="Online events"
            trailing={value.venue === 'online' ? <Check className="size-4 shrink-0 text-action" /> : undefined}
          />
          <PopoverRow
            active={value.venue === 'hybrid'}
            onClick={() => pick({ venue: 'hybrid' })}
            icon={<Blend className="size-3.5" />}
            label="Hybrid events"
            hint="In person and streamed"
            trailing={value.venue === 'hybrid' ? <Check className="size-4 shrink-0 text-action" /> : undefined}
          />
        </>
      )}

      {filteredCities.length > 0 && (
        <>
          <PopoverGroupLabel>{showEverything ? 'Popular cities' : 'Cities'}</PopoverGroupLabel>
          {filteredCities.map(c => (
            <PopoverRow
              key={c.name}
              active={value.city === c.name}
              onClick={() => pick({ city: c.name })}
              icon={<Building2 className="size-3.5" />}
              label={c.name}
              hint={`${c.count} event${c.count === 1 ? '' : 's'}`}
              trailing={value.city === c.name ? <Check className="size-4 shrink-0 text-action" /> : undefined}
            />
          ))}
        </>
      )}

      {regionGroups.map(r => (
        <div key={r.name}>
          <PopoverGroupLabel>{r.name} India</PopoverGroupLabel>
          {r.states.map(s => {
            const hit = stateCounts.find(x => x.name.toLowerCase() === s.toLowerCase())
            return (
              <PopoverRow
                key={s}
                active={value.state.toLowerCase() === s.toLowerCase()}
                onClick={() => pick({ state: s })}
                icon={<MapPin className="size-3.5" />}
                label={s}
                hint={hit ? `${hit.count} event${hit.count === 1 ? '' : 's'}` : undefined}
                trailing={value.state.toLowerCase() === s.toLowerCase()
                  ? <Check className="size-4 shrink-0 text-action" />
                  : undefined}
              />
            )
          })}
        </div>
      ))}

      {regionGroups.length === 0 && filteredCities.length === 0 && (
        <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
          Nothing matches “{query.trim()}”.
        </p>
      )}

      {!allStates && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 flex w-full cursor-pointer items-center justify-between rounded-xl px-2.5 py-2.5 text-[12.5px] font-semibold text-action transition-colors hover:bg-action/[0.05]"
        >
          Browse every state &amp; union territory
          <ChevronRight className="size-4" />
        </button>
      )}
    </DiscoveryPopover>
  )
}
