'use client'

// RD-RACEOPS-01 Sprint 4 · The ONE client island on the public results pages.
//
// Everything else renders on the server and ships no JavaScript. This is a client component
// only because it owns an input and navigates — deliberately small.
//
// Mobile: sticky under the header, 44px-plus touch targets, `enterKeyHint="search"` so the
// phone keyboard shows a Search key, and `type="search"` for the native clear affordance.

import { useCallback, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export interface ResultsSearchProps {
  /** Where to submit. The page reads `?q=`. */
  action:       string
  initialQuery: string
  placeholder?: string
  /** Stated plainly under the field so prefix-only name matching is never a surprise. */
  hint?:        string
  sticky?:      boolean
}

export function ResultsSearch({
  action, initialQuery, placeholder = 'Search by bib number or name', hint, sticky = true,
}: ResultsSearchProps) {
  const router = useRouter()
  const [query, setQuery] = useState(initialQuery)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = useCallback((value: string) => {
    const trimmed = value.trim()
    startTransition(() => {
      router.push(trimmed === '' ? action : `${action}?q=${encodeURIComponent(trimmed)}`)
    })
  }, [action, router])

  return (
    <div className={cn('z-20 -mx-4 mb-5 bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:px-0', sticky && 'sticky top-0')}>
      <form
        role="search"
        onSubmit={e => { e.preventDefault(); submit(query) }}
        className="relative"
      >
        <label htmlFor="race-results-search" className="sr-only">
          Search results by bib number or name
        </label>

        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />

        <input
          ref={inputRef}
          id="race-results-search"
          name="q"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder}
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="search"
          className={cn(
            'h-12 w-full rounded-xl border border-border bg-card pl-10 pr-24',
            'text-fs-base text-foreground placeholder:text-muted-foreground',
            'transition-colors hover:border-border-strong',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          )}
        />

        {query !== '' && (
          <button
            type="button"
            onClick={() => { setQuery(''); inputRef.current?.focus(); submit('') }}
            aria-label="Clear search"
            className="absolute right-[86px] top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}

        <button
          type="submit"
          disabled={pending}
          className={cn(
            'absolute right-1.5 top-1/2 flex h-9 min-w-[76px] -translate-y-1/2 items-center justify-center gap-1.5 rounded-lg px-3',
            'text-fs-sm font-semibold text-primary-foreground',
            'transition-opacity hover:opacity-90 disabled:opacity-60',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
          )}
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Search
        </button>
      </form>

      {hint && (
        <p className="mt-2 text-fs-2xs leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
